'use strict';

const axios = require('axios');
const _ = require('lodash');
const debug = require('debug')('hmpo:api');
const compact = require('./compact');
const buildString = require('./build-string');
const Storage = require('./storage');
const StorageFile = require('./storage-file');
const StorageRedis = require('./storage-redis');
const logger = require('./logger');

class Api {
    constructor(options) {
        this.config = _.extend({
            api: 'generic'
        }, options);
        if (this.config.saveCache) {
            this.cache = new StorageFile(this.config.api, this.config.saveCache);
        } else if (this.config.redisCache) {
            this.cache = new StorageRedis(this.config.api, this.config.redisCache);
        } else {
            this.cache = new Storage(this.config.api);
        }

        if (this.config.engineMatch) this.engineMatch = new RegExp(this.config.engineMatch);
    }

    addEngine(apis) {
        const currentEngine = apis[this.type];
        this.alternativeEngines = (currentEngine && currentEngine.alternativeEngines) || [];
        this.alternativeEngines.push(this);
        apis[this.type] = this;
    }

    getAlternativeEngine(match) {
        if (!this.alternativeEngines) return this;
        return this.alternativeEngines.find(engine => {
            if (!engine.engineMatch) return true;
            return engine.engineMatch.test(match);
        }) || this;
    }

    projectFormatLookup(options) {
        const projectFormat = options.projectFormat;
        if (!projectFormat || typeof projectFormat !== 'object')
            return buildString(projectFormat, options);
        const project = buildString('{project}', options);
        for (let projectMatch in projectFormat) {
            const re = new RegExp('^' + projectMatch + '$');
            const match = project.match(re);
            if (match) {
                const matchOptions = Object.assign({}, options, match);
                return buildString(projectFormat[projectMatch], matchOptions);
            }
        }
    }

    request(options, cb) {
        options = _.defaults({}, options, this.config, { privateToken: this.privateToken });
        options.params = _.defaults({}, options.params, this.config.params);

        let url = buildString(options.url, options);
        let params = _.compact(_.map(
            _.keys(options.params),
            key => {
                let value = buildString(options.params[key], options, '');
                if (value) return encodeURIComponent(key) + '=' + encodeURIComponent(value);
            }
        ));
        if (params.length) url += '?' + params.join('&');

        this.cache.get(url, (err, cached) => {
            if (cached) {
                debug('API Cached', url);
                return cb(null, cached);
            }

            this._request(url, options, cb);
        });
    }

    _request(url, options, cb) {
        if (options.auth && typeof options.auth === 'string') {
            let [username, password] = options.auth.split(':');
            options.auth = { username, password };
        }

        let req = {
            url,
            headers: _.mapValues(options.headers, value => buildString(value)),
            auth: options.auth,
            responseType: 'json'
        };

        debug('API Request', url);
        logger.outbound('API Request', { url });

        axios(req)
            .then(response => {
                let err;
                let body = response.data;

                if (body && body.error) {
                    err = new Error(body.error);
                }
                if (body && body.errorMessages && body.errorMessages.length) {
                    err = new Error(body.errorMessages.join(', '));
                }
                if (typeof body !== 'object') {
                    let summary = String(body).replace(/^[\s\S]*<title>([\s\S]*)<\/title>[\s\S]*$/i, '$1').substr(0, 30);
                    err = new Error('Bad JSON response from ' + url + ' ' + summary);
                }

                if (options.compact !== false) {
                    body = compact(body, options.compactIgnorePattern);
                }

                if (options.canCache === true || typeof options.canCache === 'function' && options.canCache(body, url)) {
                    let ttl = typeof options.ttl === 'function' ? options.ttl(body, url) : options.ttl;
                    this.cache.set(url, body, ttl);
                }

                cb(err, body);
            })
            .catch(err => {
                debug('API Error', err);
                err.url = url;
                cb(err);
            });
    }
}

module.exports = Api;
