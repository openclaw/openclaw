"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let jitiLoader = null;

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

function getJiti() {
  if (jitiLoader) {
    return jitiLoader;
  }

  const { createJiti } = require("jiti");
  jitiLoader = createJiti(__filename, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  return jitiLoader;
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

const target = { ...fastExports };
let rootExports = null;

function getMonolithicSdk() {
  const loaded = tryLoadMonolithicSdk();
  if (loaded && typeof loaded === "object") {
    return loaded;
  }
  return null;
}

function getExportValue(prop) {
  if (Reflect.has(target, prop)) {
    return Reflect.get(target, prop);
  }
  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }
  return Reflect.get(monolithic, prop);
}

function getExportDescriptor(prop) {
  const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
  if (ownDescriptor) {
    return ownDescriptor;
  }

  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }

  const descriptor = Reflect.getOwnPropertyDescriptor(monolithic, prop);
  if (!descriptor) {
    return undefined;
  }

  // Proxy invariants require descriptors returned for dynamic properties to be configurable.
  return {
    ...descriptor,
    configurable: true,
  };
}

rootExports = new Proxy(target, {
  get(_target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return getExportValue(prop);
  },
  has(_target, prop) {
    if (Reflect.has(target, prop)) {
      return true;
    }
    const monolithic = getMonolithicSdk();
    return monolithic ? Reflect.has(monolithic, prop) : false;
  },
  ownKeys() {
    const keys = new Set(Reflect.ownKeys(target));
    const monolithic = getMonolithicSdk();
    if (monolithic) {
      for (const key of Reflect.ownKeys(monolithic)) {
        if (!keys.has(key)) {
          keys.add(key);
        }
      }
    }
    return [...keys];
  },
  getOwnPropertyDescriptor(_target, prop) {
    return getExportDescriptor(prop);
  },
});

Object.defineProperty(target, "__esModule", {
  configurable: true,
  enumerable: false,
  writable: false,
  value: true,
});
Object.defineProperty(target, "default", {
  configurable: true,
  enumerable: false,
  get() {
    return rootExports;
  },
});

module.exports = rootExports;
