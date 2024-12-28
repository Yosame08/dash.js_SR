/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import Constants from './constants/Constants.js';
import URLLoader from './net/URLLoader.js';
import HeadRequest from './vo/HeadRequest.js';
import DashJSError from './vo/DashJSError.js';
import FactoryMaker from '../core/FactoryMaker.js';

function FragmentLoader(config) {

    config = config || {};
    const context = this.context;
    const eventBus = config.eventBus;
    const events = config.events;
    const urlUtils = config.urlUtils;
    const errors = config.errors;
    const streamId = config.streamId;

    let instance,
        urlLoader;

    function setup() {
        urlLoader = URLLoader(context).create({
            errHandler: config.errHandler,
            errors: errors,
            dashMetrics: config.dashMetrics,
            mediaPlayerModel: config.mediaPlayerModel,
            urlUtils: urlUtils,
            constants: Constants,
            boxParser: config.boxParser,
            dashConstants: config.dashConstants,
            requestTimeout: config.settings.get().streaming.fragmentRequestTimeout
        });
    }

    function checkForExistence(request) {
        const report = function (success) {
            eventBus.trigger(events.CHECK_FOR_EXISTENCE_COMPLETED, { request: request, exists: success }
            );
        };

        if (request) {
            let headRequest = new HeadRequest(request.url);
            urlLoader.load({
                request: headRequest,
                success: function () {
                    report(true);
                },
                error: function () {
                    report(false);
                }
            });
        } else {
            report(false);
        }
    }

    // generate UUID for SR
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    const identifier = generateUUID();
    let idx = 0;

    function load(request) {
        const report = function (data, error) {
            eventBus.trigger(events.LOADING_COMPLETED, {
                request: request,
                response: data || null,
                error: error || null,
                sender: instance
            });
        };

        const sr_api = function (api, data, filename, idx) {
            const initFormData = new FormData();
            initFormData.append('metadata', JSON.stringify({
                identifier: identifier,
                filename: filename,
                idx: idx
            }, { type: 'application/json' }));
            initFormData.append('file', new Blob([data], { type: 'application/octet-stream' }));

            fetch('http://127.0.0.1:5000/' + api, {
                method: 'POST',
                body: initFormData
            }).then(response => {
                if (response.status === 200) {
                    if (api === 'sr') {
                        response.blob().then(blob => {
                            const reader = new FileReader();
                            reader.onload = function() {
                                const arrayBuffer = reader.result;
                                report(arrayBuffer, undefined);
                            };
                            reader.readAsArrayBuffer(blob);
                        });
                    }
                    else if (api === 'header') {
                        report(data);
                    }
                    else {
                        throw new Error('Unknown API');
                    }
                } else {
                    report(undefined, new DashJSError(
                        errors.SR_ERROR_CODE, 'Failed to send header', response.statusText
                    ));
                }
            }).catch(error => {
                report(undefined, new DashJSError(errors.SR_ERROR_CODE, error.message, 'FetchError'));
            });
        }

        if (request) {
            let idx_now = ++idx;
            urlLoader.load({
                request: request,
                progress: function (event) {
                    eventBus.trigger(events.LOADING_PROGRESS, {
                        request: request,
                        stream: event.stream,
                        streamId
                    });

                    // Only in case of FetchAPI and low latency streaming. XHR does not have data attribute.
                    if (event.data) {
                        eventBus.trigger(events.LOADING_DATA_PROGRESS, {
                            request: request,
                            response: event.data || null,
                            error: null,
                            sender: instance
                        });
                    }
                },
                success: function (data) {
                    // if (false) {
                    if (request.mediaType === 'video') {
                        switch (request.type) {
                            case 'InitializationSegment':
                                sr_api('header', data, request.url.split('/').pop(), idx_now);
                                break;
                            case 'MediaSegment':
                                sr_api('sr', data, request.url.split('/').pop(), idx_now);
                                break;
                        }
                    } else {
                        report(data);
                    }
                },
                error: function (request, statusText, errorText) {
                    report(
                        undefined,
                        new DashJSError(
                            errors.FRAGMENT_LOADER_LOADING_FAILURE_ERROR_CODE,
                            errorText,
                            statusText
                        )
                    );
                },
                abort: function (request) {
                    if (request) {
                        eventBus.trigger(events.LOADING_ABANDONED, {
                            mediaType: request.mediaType,
                            request: request,
                            sender: instance
                        });
                    }
                }
            });
        } else {
            report(
                undefined,
                new DashJSError(
                    errors.FRAGMENT_LOADER_NULL_REQUEST_ERROR_CODE,
                    errors.FRAGMENT_LOADER_NULL_REQUEST_ERROR_MESSAGE
                )
            );
        }
    }

    function abort() {
        if (urlLoader) {
            urlLoader.abort();
        }
    }

    function resetInitialSettings() {
        if (urlLoader) {
            urlLoader.resetInitialSettings();
        }
    }

    function reset() {
        if (urlLoader) {
            urlLoader.abort();
            urlLoader.reset();
            urlLoader = null;
        }
    }

    instance = {
        abort,
        checkForExistence,
        load,
        reset,
        resetInitialSettings
    };

    setup();

    return instance;
}

FragmentLoader.__dashjs_factory_name = 'FragmentLoader';
export default FactoryMaker.getClassFactory(FragmentLoader);
