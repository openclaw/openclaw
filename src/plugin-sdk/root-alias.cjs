"use strict";

const path = require("node:path");
const fs = require("node:fs");

const MONOLITHIC_SDK_UNCHECKED = Symbol("monolithic-sdk-unchecked");
const MONOLITHIC_SDK_UNAVAILABLE = Symbol("monolithic-sdk-unavailable");

let monolithicSdk = MONOLITHIC_SDK_UNCHECKED;
let legacyJiti = null;
const legacyModuleCache = new Map();

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

function createJitiLoader() {
  if (legacyJiti) {
    return legacyJiti;
  }
  const { createJiti } = require("jiti");
  legacyJiti = createJiti(__filename, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  return legacyJiti;
}

function loadMonolithicSdk() {
  if (monolithicSdk !== MONOLITHIC_SDK_UNCHECKED) {
    return monolithicSdk === MONOLITHIC_SDK_UNAVAILABLE ? null : monolithicSdk;
  }

  monolithicSdk = MONOLITHIC_SDK_UNAVAILABLE;

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "index.js");
  if (!fs.existsSync(distCandidate)) {
    return null;
  }

  try {
    monolithicSdk = createJitiLoader()(distCandidate);
    return monolithicSdk;
  } catch {
    return null;
  }
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

const legacyExportMap = {
  isDangerousNameMatchingEnabled: "../config/dangerous-name-matching.js",
  createAccountListHelpers: "../channels/plugins/account-helpers.js",
  buildAgentMediaPayload: "./agent-media-payload.js",
  createReplyPrefixOptions: "../channels/reply-prefix.js",
  createTypingCallbacks: "../channels/typing.js",
  logInboundDrop: "../channels/logging.js",
  logTypingFailure: "../channels/logging.js",
  buildPendingHistoryContextFromMap: "../auto-reply/reply/history.js",
  clearHistoryEntriesIfEnabled: "../auto-reply/reply/history.js",
  recordPendingHistoryEntryIfEnabled: "../auto-reply/reply/history.js",
  resolveControlCommandGate: "../channels/command-gating.js",
  resolveDmGroupAccessWithLists: "../security/dm-policy-shared.js",
  resolveAllowlistProviderRuntimeGroupPolicy: "../config/runtime-group-policy.js",
  resolveDefaultGroupPolicy: "../config/runtime-group-policy.js",
  resolveChannelMediaMaxBytes: "../channels/plugins/media-limits.js",
  warnMissingProviderGroupPolicyFallbackOnce: "../config/runtime-group-policy.js",
  normalizePluginHttpPath: "../plugins/http-path.js",
  registerPluginHttpRoute: "../plugins/http-registry.js",
  DEFAULT_ACCOUNT_ID: "../routing/session-key.js",
  DEFAULT_GROUP_HISTORY_LIMIT: "../auto-reply/reply/history.js",
};
const legacyExportNames = new Set(Object.keys(legacyExportMap));

function loadLegacyModule(specifier) {
  if (legacyModuleCache.has(specifier)) {
    return legacyModuleCache.get(specifier);
  }
  const loaded = createJitiLoader()(path.resolve(__dirname, specifier));
  legacyModuleCache.set(specifier, loaded);
  return loaded;
}

function loadLegacyExport(prop) {
  const monolithic = loadMonolithicSdk();
  if (monolithic) {
    return monolithic[prop];
  }
  const specifier = legacyExportMap[prop];
  if (!specifier) {
    return undefined;
  }
  return loadLegacyModule(specifier)[prop];
}

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
    if (legacyExportNames.has(prop)) {
      return loadLegacyExport(prop);
    }
    const monolithic = loadMonolithicSdk();
    return monolithic ? monolithic[prop] : undefined;
  },
  has(target, prop) {
    if (prop === "__esModule" || prop === "default") {
      return true;
    }
    if (Reflect.has(target, prop)) {
      return true;
    }
    if (legacyExportNames.has(prop)) {
      return true;
    }
    const monolithic = tryLoadMonolithicSdk();
    return monolithic ? prop in monolithic : false;
  },
  ownKeys(target) {
    const keys = new Set([
      ...Reflect.ownKeys(target),
      ...legacyExportNames,
      "default",
      "__esModule",
    ]);
    const monolithic = tryLoadMonolithicSdk();
    if (monolithic) {
      for (const key of Reflect.ownKeys(monolithic)) {
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
    if (legacyExportNames.has(prop)) {
      return {
        configurable: true,
        enumerable: true,
        get() {
          return loadLegacyExport(prop);
        },
      };
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
