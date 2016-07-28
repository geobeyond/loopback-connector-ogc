// Copyright Geobeyond 2016. All Rights Reserved.
// Node module: loopback-connector-ogc

var ows = require('ows');
var debug = require('debug')('loopback:connector:ogc');
var HttpClient = require('./http');

/**
 * Export the initialize method to loopback-datasource-juggler
 * @param {DataSource} dataSource The data source object
 * @param callback
 */
exports.initialize = function initializeDataSource(dataSource, callback) {
  var settings = dataSource.settings || {};

  var connector = new OGCConnector(settings);

  dataSource.connector = connector;
  dataSource.connector.dataSource = dataSource;

  connector.connect(callback);

};

/**
 * The OGCConnector constructor
 * @param {Object} settings The connector settings
 * @constructor
 */
function OGCConnector(settings) {
  settings = settings || {};
  var endpoint = settings.endpoint || settings.url;
  var getCapabilities = settings.getCapabilities || (endpoint + '?request=GetCapabilities');

  this.settings = settings;
  if (this.settings.ignoredNamespaces == null) {
    // Some Capabilities documents use tns as the prefix. Without the customization below, it
    // will remove tns: for qualified elements
    this.settings.ignoredNamespaces = {
      namespaces: [],
      override: true
    }
  }
  this.settings.httpClient = new HttpClient(settings, this);

  this.endpoint = endpoint; // The endpoint url
  this.getCapabilities = getCapabilities; // URL or path to the url

  if (debug.enabled) {
    debug('Settings: %j', settings);
  }

  this._models = {};
  this.DataAccessObject = function () {
    // Dummy function
  };
}

OGCConnector.prototype.connect = function (cb) {
  var self = this;
  if (self.client) {
    process.nextTick(function () {
      cb && cb(null, self.client);
    });
    return;
  }
  if (debug.enabled) {
    debug('Reading getCapabilities: %s', self.getCapabilities);
  }
  ows.createClient(self.getCapabilities, self.settings, function (err, client) {
    if (!err) {
      if (debug.enabled) {
        debug('Capabilities document loaded: %s', self.getCapabilities);
      }
      if (self.settings.security || self.settings.username) {
        var sec = null;
        var secConfig = self.settings.security || self.settings;
        if (debug.enabled) {
          debug('configuring security: %j', secConfig);
        }
        switch (secConfig.scheme) {
          case 'WS':
          case 'Security':
            sec = new ows.Security(secConfig.username, secConfig.password,
              secConfig.passwordType || secConfig.options);
            break;
          case 'SecurityCert':
            sec = new ows.SecurityCert(
              secConfig.privatePEM,
              secConfig.publicP12PEM,
              secConfig.password,
              secConfig.encoding
            );
            break;
          case 'ClientSSL':
            if (sec.pfx) {
              sec = new ows.ClientSSLSecurityPFX(
                secConfig.pfx,
                secConfig.passphrase,
                secConfig.options
              );
            } else {
              sec = new ows.ClientSSLSecurity(
                secConfig.keyPath || secConfig.key,
                secConfig.certPath || secConfig.cert,
                secConfig.ca || secConfig.caPath,
                secConfig.options);
            }
            break;
          case 'Bearer':
            sec = new ows.BearerSecurity(
              secConfig.token,
              secConfig.options);
            break;
          case 'BasicAuth':
          default:
            sec = new ows.BasicAuthSecurity(
              secConfig.username, secConfig.password, secConfig.options);
            break;
        }
        if (sec) {
          client.setSecurity(sec);
        }
      }
      if (self.settings.owsService || self.settings.OWSService) {
        client.setOWSService(self.settings.owsService || self.settings.OWSService);
      }

      if (Array.isArray(self.settings.owsHeaders)) {
        self.settings.owsHeaders.forEach(function (header) {
          if (debug.enabled) {
            debug('adding ows header: %j', header);
          }
          if (typeof header === 'object') {
            client.addOwsHeader(client.getCapabilities.objectToXML(header.element, header.name,
              header.prefix, header.namespace, true));
          } else if (typeof header === 'string') {
            client.addSoapHeader(header);
          }
        });
      }

      client.connector = self;
      self.client = client;
      self.setupDataAccessObject();
    }
    // If the getCapabilities is cached, the callback from ows.createClient is sync (BUG!)
    if (cb) {
      process.nextTick(function () {
        cb(err, client);
      });
    }
  }, self.endpoint);
};

/**
 * Find or derive the method name from service/port/operation
 * @param {String} serviceName The WSDL service name
 * @param {String} portName The WSDL port name
 * @param {String} operationName The WSDL operation name
 * @param {Object} dao The data access objecr
 * @returns {String} The method name
 * @private
 */
OGCConnector.prototype._methodName = function (serviceName, portName, operationName, dao) {
  var methods = this.settings.operations || {};
  for (var m in methods) {
    var method = methods[m];
    if (method.service === serviceName && method.port === portName &&
      (method.operation === operationName ||
        method.operation === undefined && m === operationName)) {
      // Return the matched method name
      return m;
    }
  }

  if (dao && (operationName in dao)) {
    // The operation name exists, return full name
    return serviceName + '_' + portName + '_' + operationName;
  } else {
    return operationName;
  }
};

function setRemoting(wsMethod) {
  wsMethod.shared = true;
  wsMethod.accepts = [
    {arg: 'input', type: 'object', required: true,
      http: {source: 'body'}}
  ];
  wsMethod.returns = {arg: 'output', type: 'object', root: true};
}


function findKey(obj, val) {
  for (var n in obj) {
    if (obj[n] === val) {
      return n;
    }
  }
  return null;
}

function findMethod(client, name) {
  var portTypes = client.getCapabilities.definitions.portTypes;
  for (var p in portTypes) {
    var pt = portTypes[p];
    for (var op in pt.methods) {
      if (op === name) {
        return pt.methods[op];
      }
    }
  }
  return null;
}

OGCConnector.prototype.jsonToXML = function (method, json) {
  if (!json) {
    return '';
  }
  if (typeof method === 'string') {
    var m = findMethod(this.client, method);
    if(!m) {
      throw new Error('Method not found in getCapabilities port types: ' + m);
    } else {
      method = m;
    }
  }
  var client = this.client,
    name = method.$name,
    input = method.input,
    defs = client.getCapabilities.definitions,
    ns = defs.$targetNamespace,
    message = '';

  var alias = findKey(defs.xmlns, ns);

  if (input.parts) {
    message = client.getCapabilities.objectToRpcXML(name, json, alias, ns);
  } else if (typeof json === 'string') {
    message = json;
  } else {
    message = client.getCapabilities.objectToDocumentXML(input.$name, json,
      input.targetNSAlias, input.targetNamespace, input.$type);
  }
  return message;
}

OGCConnector.prototype.xmlToJSON = function (method, xml) {
  if(!xml) {
    return {};
  }
  if (typeof method === 'string') {
    var m = findMethod(this.client, method);
    if(!m) {
      throw new Error('Method not found in getCapabilities port types: ' + m);
    } else {
      method = m;
    }
  }
  var input = method.input,
    output = method.output;

  var json = this.client.getCapabilities.xmlToObject(xml);
  var result = json.Body[output.$name] || json.Body[input.$name];
  // RPC/literal response body may contain elements with added suffixes I.E.
  // 'Response', or 'Output', or 'Out'
  // This doesn't necessarily equal the output message name. See WSDL 1.1 Section 2.4.5
  if(!result){
    result = json.Body[output.$name.replace(/(?:Out(?:put)?|Response)$/, '')];
  }
  return result;
};

/**
 *
 * @private
 * @returns {*}
 */
OGCConnector.prototype.setupDataAccessObject = function () {
  var self = this;
  if (this.getCapabilitiesParsed && this.DataAccessObject) {
    return this.DataAccessObject;
  }

  this.getCapabilitiesParsed = true;

  this.DataAccessObject.xmlToJSON = OGCConnector.prototype.xmlToJSON.bind(self);
  this.DataAccessObject.jsonToXML = OGCConnector.prototype.jsonToXML.bind(self);

  for (var s in this.client.getCapabilities.services) {
    var service = this.client[s];
    for (var p in service) {
      var port = service[p];
      for (var m in port) {
        var method = port[m];
        if (debug.enabled) {
          debug('Adding method: %s %s %s', s, p, m);
        }

        var methodName = this._methodName(s, p, m, this.DataAccessObject);
        if (debug.enabled) {
          debug('Method name: %s', methodName);
        }
        var wsMethod = method.bind(this.client);

        wsMethod.jsonToXML = OGCConnector.prototype.jsonToXML.bind(self, findMethod(self.client, m));
        wsMethod.xmlToJSON = OGCConnector.prototype.xmlToJSON.bind(self, findMethod(self.client, m));
        this.DataAccessObject[methodName] = wsMethod;
        if (this.settings.remotingEnabled) {
          setRemoting(wsMethod);
        }
      }
    }
  }
  this.dataSource.DataAccessObject = this.DataAccessObject;
  for (var model in this._models) {
    if (debug.enabled) {
      debug('Mixing methods into : %s', model);
    }
    this.dataSource.mixin(this._models[model].model);
  }
  return this.DataAccessObject;
};

/**
 * Hook for defining a model by the data source
 * @param {object} modelDef The model description
 */
OGCConnector.prototype.define = function (modelDef) {
  var m = modelDef.model.modelName;
  this._models[m] = modelDef;
};

/**
 * Get types associated with the connector
 * @returns {String[]} The types for the connector
 */
OGCConnector.prototype.getTypes = function() {
  return ['ows'];
};

/**
 * Attempt to test the connectivity that the ogc driver depends on.
 */

OGCConnector.prototype.ping = function (cb) {
  ready(this.dataSource, function(err) {
    var connectionError;
    if (err) {
      connectionError = new Error('NOT Connected');
      connectionError.originalError = err;
      return cb(connectionError);
    } else {
      cb();
    }
  });
};

function ready(dataSource, cb) {
  if (dataSource.connected) {
    // Connected
    return process.nextTick(function() {
      cb();
    });
  }

  var timeoutHandle;

  function onConnected() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    cb();
  };

  function onError(err) {
    // Remove the connected listener
    dataSource.removeListener('connected', onConnected);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    var params = [].slice.call(args);
    var cb = params.pop();
    if (typeof cb === 'function') {
      process.nextTick(function() {
        cb(err);
      });
    }
  };
  dataSource.once('connected', onConnected);
  dataSource.once('error', onError);

  // Set up a timeout to cancel the invocation
  var timeout = dataSource.settings.connectionTimeout || 60000;
  timeoutHandle = setTimeout(function() {
    dataSource.removeListener('error', onError);
    self.removeListener('connected', onConnected);
    var params = [].slice.call(args);
    var cb = params.pop();
    if (typeof cb === 'function') {
      cb(new Error('Timeout in connecting after ' + timeout + ' ms'));
    }
  }, timeout);

  if (!dataSource.connecting) {
    dataSource.connect();
  }
}


