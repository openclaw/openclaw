"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let jitiLoader = null;
const targetedLegacyLoaders = {
  resolveControlCommandGate: () =>
    loadModuleExport(
      path.resolve(__dirname, "..", "channels", "command-gating.ts"),
      "resolveControlCommandGate",
    ),
};

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

function getJiti() {
  if (!jitiLoader) {
    const { createJiti } = require("jiti");
    jitiLoader = createJiti(__filename, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    });
  }
  return jitiLoader;
}

function loadModuleExport(modulePath, exportName) {
  const moduleExports = getJiti()(modulePath);
  return moduleExports?.[exportName];
}

function loadMonolithicSdk() {
  if (monolithicSdk) {
    return monolithicSdk;
  }

  const jiti = getJiti();

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "index.js");
  if (fs.existsSync(distCandidate)) {
    try {
      monolithicSdk = jiti(distCandidate);
      return monolithicSdk;
    } catch {
      // Fall through to source alias if dist is unavailable or stale.
    }
  }

  monolithicSdk = jiti(path.join(__dirname, "index.ts"));
  return monolithicSdk;
}

function tryLoadMonolithicSdk() {
  try {
    return loadMonolithicSdk();
  } catch {
    return null;
  }
}

const fastExports = {
  emptyPluginConfigSchema,
  resolveControlCommandGate,
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
    if (typeof prop === "string" && prop in targetedLegacyLoaders) {
      return targetedLegacyLoaders[prop]();
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
    if (typeof prop === "string" && prop in targetedLegacyLoaders) {
      return true;
    }
    return prop in loadMonolithicSdk();
  },
  ownKeys(target) {
    const monolithicKeys = monolithicSdk ? Reflect.ownKeys(monolithicSdk) : [];
    const keys = new Set([
      ...Reflect.ownKeys(target),
      ...Reflect.ownKeys(targetedLegacyLoaders),
      ...monolithicKeys,
      "default",
      "__esModule",
    ]);
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
    if (typeof prop === "string" && prop in targetedLegacyLoaders) {
      return {
        configurable: true,
        enumerable: true,
        get: () => targetedLegacyLoaders[prop](),
      };
    }
    if (!monolithicSdk) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(monolithicSdk, prop);
    if (!descriptor) {
      return undefined;
    }
    if (descriptor.get || descriptor.set) {
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
