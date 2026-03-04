"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let jitiLoader = null;
let monolithicExportKeys = null;
let monolithicExportKeySet = null;

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

function resolveMonolithicCandidates() {
  const srcCandidate = path.join(__dirname, "index.ts");
  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "index.js");
  // Prefer source when present to avoid stale dist metadata/runtime skew in repo checkouts.
  const candidates = [srcCandidate, distCandidate].filter((candidate, index, all) => {
    return all.indexOf(candidate) === index && fs.existsSync(candidate);
  });
  return candidates.length > 0 ? candidates : [srcCandidate, distCandidate];
}

function loadMonolithicSdk() {
  if (monolithicSdk) {
    return monolithicSdk;
  }

  const jiti = getJiti();
  for (const candidate of resolveMonolithicCandidates()) {
    try {
      monolithicSdk = jiti(candidate);
      return monolithicSdk;
    } catch {
      // Try the next candidate (e.g. stale dist fallback to source).
    }
  }

  monolithicSdk = jiti(path.join(__dirname, "index.ts"));
  return monolithicSdk;
}

function parseNamedExports(content) {
  const keys = [];
  const exportBlock = /export\s+(?!type\b)\{([\s\S]*?)\}\s*(?:from\s+["'][^"']+["'])?\s*;/g;
  let match = null;
  while ((match = exportBlock.exec(content)) !== null) {
    const block = match[1] ?? "";
    const parts = block.split(",");
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part || part.startsWith("type ")) {
        continue;
      }
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(part);
      if (asMatch) {
        keys.push(asMatch[1]);
        continue;
      }
      const nameMatch = /([A-Za-z_$][\w$]*)$/u.exec(part);
      if (nameMatch) {
        keys.push(nameMatch[1]);
      }
    }
  }
  return [...new Set(keys)];
}

function resolveMonolithicExportKeys() {
  if (monolithicSdk) {
    return Reflect.ownKeys(monolithicSdk);
  }
  if (monolithicExportKeys) {
    return monolithicExportKeys;
  }

  for (const candidate of resolveMonolithicCandidates()) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const parsed = parseNamedExports(fs.readFileSync(candidate, "utf8"));
      if (parsed.length > 0) {
        monolithicExportKeys = parsed;
        monolithicExportKeySet = new Set(parsed);
        return monolithicExportKeys;
      }
    } catch {
      // Fall through to monolithic runtime loading.
    }
  }

  monolithicExportKeys = Reflect.ownKeys(loadMonolithicSdk());
  monolithicExportKeySet = new Set(monolithicExportKeys.filter((key) => typeof key === "string"));
  return monolithicExportKeys;
}

function hasKnownMonolithicExport(prop) {
  if (typeof prop !== "string") {
    return false;
  }
  if (monolithicSdk) {
    return prop in monolithicSdk;
  }
  if (!monolithicExportKeySet) {
    resolveMonolithicExportKeys();
  }
  return Boolean(monolithicExportKeySet?.has(prop));
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
    if (hasKnownMonolithicExport(prop)) {
      return true;
    }
    return prop in loadMonolithicSdk();
  },
  ownKeys(target) {
    const monolithicKeys = monolithicSdk
      ? Reflect.ownKeys(monolithicSdk)
      : resolveMonolithicExportKeys();
    const keys = new Set([...Reflect.ownKeys(target), ...monolithicKeys, "default", "__esModule"]);
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
    if (!monolithicSdk && hasKnownMonolithicExport(prop)) {
      return {
        configurable: true,
        enumerable: true,
        get() {
          return loadMonolithicSdk()[prop];
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
