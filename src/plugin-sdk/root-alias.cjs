"use strict";

const path = require("node:path");
const fs = require("node:fs");

// Global symbol for shared jiti instance (set by plugins/loader.ts)
const JITI_LOADER_SYMBOL = Symbol.for("openclaw.pluginJitiLoader");

let monolithicSdk = null;
let localJitiLoader = null;

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

function resolveCommandAuthorizedFromAuthorizers(params) {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

function resolveControlCommandGate(params) {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: params.authorizers,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

/**
 * Get the jiti loader instance.
 * Prefers the shared instance from plugins/loader.ts (which has scoped aliases configured).
 * Falls back to creating a local instance for backwards compatibility.
 */
function getJiti() {
  // First, try to use the shared jiti instance from plugins/loader.ts
  // This instance has all the scoped aliases (openclaw/plugin-sdk/telegram, etc.)
  const globalJiti = globalThis[JITI_LOADER_SYMBOL];
  if (globalJiti) {
    return globalJiti;
  }

  // Fallback: create a local jiti instance (no scoped aliases)
  // This path is only hit if root-alias.cjs is loaded before plugins/loader.ts
  if (localJitiLoader) {
    return localJitiLoader;
  }

  const { createJiti } = require("jiti");
  localJitiLoader = createJiti(__filename, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  return localJitiLoader;
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
    return loadMonolithicSdk()[prop];
  },
  has(target, prop) {
    if (prop === "__esModule" || prop === "default") {
      return true;
    }
    if (Reflect.has(target, prop)) {
      return true;
    }
    const monolithic = tryLoadMonolithicSdk();
    return monolithic ? prop in monolithic : false;
  },
  ownKeys(target) {
    const keys = new Set([...Reflect.ownKeys(target), "default", "__esModule"]);
    // Keep Object.keys/property reflection fast and deterministic.
    // Only expose monolithic keys if it was already loaded by direct access.
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
    const monolithic = tryLoadMonolithicSdk();
    if (!monolithic) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(monolithic, prop);
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
