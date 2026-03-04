"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let jiti = null;
const legacyFastExportCache = Object.create(null);

function emptyPluginConfigSchema() {
  function error(message) {
    return { success: false, error: { issues: [{ path: [], message }] } };
  }

  return {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function loadMonolithicSdk() {
  if (monolithicSdk) {
    return monolithicSdk;
  }

  const loader = getJiti();

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "index.js");
  if (fs.existsSync(distCandidate)) {
    try {
      monolithicSdk = loader(distCandidate);
      return monolithicSdk;
    } catch {
      // Fall through to source alias if dist is unavailable or stale.
    }
  }

  monolithicSdk = loader(path.join(__dirname, "index.ts"));
  return monolithicSdk;
}

function getJiti() {
  if (jiti) {
    return jiti;
  }

  const { createJiti } = require("jiti");
  jiti = createJiti(__filename, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });

  return jiti;
}

const legacyFastExportLoaders = {
  resolveControlCommandGate: () => {
    const mod = getJiti()(path.join(__dirname, "..", "channels", "command-gating.ts"));
    return mod.resolveControlCommandGate;
  },
};

function hasLegacyFastExport(prop) {
  return (
    typeof prop === "string" && Object.prototype.hasOwnProperty.call(legacyFastExportLoaders, prop)
  );
}

function loadLegacyFastExport(prop) {
  if (!hasLegacyFastExport(prop)) {
    return undefined;
  }
  if (!(prop in legacyFastExportCache)) {
    legacyFastExportCache[prop] = legacyFastExportLoaders[prop]();
  }
  return legacyFastExportCache[prop];
}

const fastExports = {
  emptyPluginConfigSchema,
};

const rootProxy = new Proxy(fastExports, {
  get(target, prop, receiver) {
    if (prop === "__esModule") {
      return true;
    }
    if (prop === "default") {
      return rootProxy;
    }
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    if (hasLegacyFastExport(prop)) {
      return loadLegacyFastExport(prop);
    }
    return loadMonolithicSdk()[prop];
  },
  has(target, prop) {
    if (prop === "__esModule" || prop === "default") {
      return true;
    }
    if (Reflect.has(target, prop)) {
      return true;
    }
    if (hasLegacyFastExport(prop)) {
      return true;
    }
    return prop in loadMonolithicSdk();
  },
  ownKeys(target) {
    const keys = new Set([
      ...Reflect.ownKeys(target),
      ...Object.keys(legacyFastExportLoaders),
      "default",
      "__esModule",
    ]);
    if (monolithicSdk) {
      for (const key of Reflect.ownKeys(monolithicSdk)) {
        keys.add(key);
      }
    }
    return [...keys];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === "__esModule") {
      return {
        configurable: true,
        enumerable: false,
        writable: false,
        value: true,
      };
    }
    if (prop === "default") {
      return {
        configurable: true,
        enumerable: false,
        writable: false,
        value: rootProxy,
      };
    }
    const own = Object.getOwnPropertyDescriptor(target, prop);
    if (own) {
      return own;
    }
    if (hasLegacyFastExport(prop)) {
      return {
        configurable: true,
        enumerable: true,
        get() {
          return loadLegacyFastExport(prop);
        },
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(loadMonolithicSdk(), prop);
    if (!descriptor) {
      return undefined;
    }
    if (descriptor.get || descriptor.set) {
      const monolithic = loadMonolithicSdk();
      return {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
        get: descriptor.get
          ? function getLegacyValue() {
              return descriptor.get.call(monolithic);
            }
          : undefined,
        set: descriptor.set
          ? function setLegacyValue(value) {
              return descriptor.set.call(monolithic, value);
            }
          : undefined,
      };
    }
    return {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      value: descriptor.value,
      writable: descriptor.writable,
    };
  },
});

module.exports = rootProxy;
