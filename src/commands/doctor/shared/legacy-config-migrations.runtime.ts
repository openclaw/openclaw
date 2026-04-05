import {
  buildDefaultControlUiAllowedOrigins,
  hasConfiguredControlUiAllowedOrigins,
  isGatewayNonLoopbackBindMode,
  resolveGatewayPortWithDefault,
} from "../../../config/gateway-control-ui-origins.js";
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { DEFAULT_GATEWAY_PORT } from "../../../config/paths.js";
import { isBlockedObjectKey } from "../../../config/prototype-keys.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const AGENT_HEARTBEAT_KEYS = new Set([
  "every",
  "activeHours",
  "model",
  "session",
  "includeReasoning",
  "target",
  "directPolicy",
  "to",
  "accountId",
  "prompt",
  "ackMaxChars",
  "suppressToolErrorWarnings",
  "lightContext",
  "isolatedSession",
]);

const CHANNEL_HEARTBEAT_KEYS = new Set(["showOk", "showAlerts", "useIndicator"]);
const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;
const LEGACY_TTS_PLUGIN_IDS = new Set(["voice-call"]);

function sandboxScopeFromPerSession(perSession: boolean): "session" | "shared" {
  return perSession ? "session" : "shared";
}

function isLegacyGatewayBindHostAlias(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "auto" ||
    normalized === "loopback" ||
    normalized === "lan" ||
    normalized === "tailnet" ||
    normalized === "custom"
  ) {
    return false;
  }
  return (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "*" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function splitLegacyHeartbeat(legacyHeartbeat: Record<string, unknown>): {
  agentHeartbeat: Record<string, unknown> | null;
  channelHeartbeat: Record<string, unknown> | null;
} {
  const agentHeartbeat: Record<string, unknown> = {};
  const channelHeartbeat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(legacyHeartbeat)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (CHANNEL_HEARTBEAT_KEYS.has(key)) {
      channelHeartbeat[key] = value;
      continue;
    }
    if (AGENT_HEARTBEAT_KEYS.has(key)) {
      agentHeartbeat[key] = value;
      continue;
    }
    // Preserve unknown fields under the agent heartbeat namespace so validation
    // still surfaces unsupported keys instead of silently dropping user input.
    agentHeartbeat[key] = value;
  }

  return {
    agentHeartbeat: Object.keys(agentHeartbeat).length > 0 ? agentHeartbeat : null,
    channelHeartbeat: Object.keys(channelHeartbeat).length > 0 ? channelHeartbeat : null,
  };
}

function mergeLegacyIntoDefaults(params: {
  raw: Record<string, unknown>;
  rootKey: "agents" | "channels";
  fieldKey: string;
  legacyValue: Record<string, unknown>;
  changes: string[];
  movedMessage: string;
  mergedMessage: string;
}) {
  const root = ensureRecord(params.raw, params.rootKey);
  const defaults = ensureRecord(root, "defaults");
  const existing = getRecord(defaults[params.fieldKey]);
  if (!existing) {
    defaults[params.fieldKey] = params.legacyValue;
    params.changes.push(params.movedMessage);
  } else {
    // defaults stays authoritative; legacy top-level config only fills gaps.
    const merged = structuredClone(existing);
    mergeMissing(merged, params.legacyValue);
    defaults[params.fieldKey] = merged;
    params.changes.push(params.mergedMessage);
  }

  root.defaults = defaults;
  params.raw[params.rootKey] = root;
}

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = getRecord(value);
  if (!tts) {
    return false;
  }
  return LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(tts, key));
}

function hasLegacySandboxPerSession(value: unknown): boolean {
  const sandbox = getRecord(value);
  return Boolean(sandbox && Object.prototype.hasOwnProperty.call(sandbox, "perSession"));
}

function hasLegacyAgentListSandboxPerSession(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((agent) => hasLegacySandboxPerSession(getRecord(agent)?.sandbox));
}
function hasLegacyPluginEntryTtsProviderKeys(value: unknown): boolean {
  const entries = getRecord(value);
  if (!entries) {
    return false;
  }
  return Object.entries(entries).some(([pluginId, entryValue]) => {
    if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
      return false;
    }
    const entry = getRecord(entryValue);
    const config = getRecord(entry?.config);
    return hasLegacyTtsProviderKeys(config?.tts);
  });
}

function getOrCreateTtsProviders(tts: Record<string, unknown>): Record<string, unknown> {
  const providers = getRecord(tts.providers) ?? {};
  tts.providers = providers;
  return providers;
}

function mergeLegacyTtsProviderConfig(
  tts: Record<string, unknown>,
  legacyKey: string,
  providerId: string,
): boolean {
  const legacyValue = getRecord(tts[legacyKey]);
  if (!legacyValue) {
    return false;
  }
  const providers = getOrCreateTtsProviders(tts);
  const existing = getRecord(providers[providerId]) ?? {};
  const merged = structuredClone(existing);
  mergeMissing(merged, legacyValue);
  providers[providerId] = merged;
  delete tts[legacyKey];
  return true;
}

function migrateLegacyTtsConfig(
  tts: Record<string, unknown> | null | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!tts) {
    return;
  }
  const movedOpenAI = mergeLegacyTtsProviderConfig(tts, "openai", "openai");
  const movedElevenLabs = mergeLegacyTtsProviderConfig(tts, "elevenlabs", "elevenlabs");
  const movedMicrosoft = mergeLegacyTtsProviderConfig(tts, "microsoft", "microsoft");
  const movedEdge = mergeLegacyTtsProviderConfig(tts, "edge", "microsoft");

  if (movedOpenAI) {
    changes.push(`Moved ${pathLabel}.openai → ${pathLabel}.providers.openai.`);
  }
  if (movedElevenLabs) {
    changes.push(`Moved ${pathLabel}.elevenlabs → ${pathLabel}.providers.elevenlabs.`);
  }
  if (movedMicrosoft) {
    changes.push(`Moved ${pathLabel}.microsoft → ${pathLabel}.providers.microsoft.`);
  }
  if (movedEdge) {
    changes.push(`Moved ${pathLabel}.edge → ${pathLabel}.providers.microsoft.`);
  }
}

const MEMORY_SEARCH_RULE: LegacyConfigRule = {
  path: ["memorySearch"],
  message:
    'top-level memorySearch was moved; use agents.defaults.memorySearch instead. Run "openclaw doctor --fix".',
};

const GATEWAY_BIND_RULE: LegacyConfigRule = {
  path: ["gateway", "bind"],
  message:
    'gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead. Run "openclaw doctor --fix".',
  match: (value) => isLegacyGatewayBindHostAlias(value),
  requireSourceLiteral: true,
};

const HEARTBEAT_RULE: LegacyConfigRule = {
  path: ["heartbeat"],
  message:
    "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
};

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

const LEGACY_TTS_RULES: LegacyConfigRule[] = [
  {
    path: ["messages", "tts"],
    message:
      'messages.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use messages.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsProviderKeys(value),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use plugins.entries.voice-call.config.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyPluginEntryTtsProviderKeys(value),
  },
];

const LEGACY_SANDBOX_SCOPE_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "sandbox"],
    message:
      'agents.defaults.sandbox.perSession is legacy; use agents.defaults.sandbox.scope instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacySandboxPerSession(value),
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].sandbox.perSession is legacy; use agents.list[].sandbox.scope instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAgentListSandboxPerSession(value),
  },
];

function migrateLegacySandboxPerSession(
  sandbox: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): void {
  if (!Object.prototype.hasOwnProperty.call(sandbox, "perSession")) {
    return;
  }
  const rawPerSession = sandbox.perSession;
  if (typeof rawPerSession === "boolean") {
    if (sandbox.scope === undefined) {
      sandbox.scope = sandboxScopeFromPerSession(rawPerSession);
      changes.push(
        `Moved ${pathLabel}.perSession → ${pathLabel}.scope (${String(sandbox.scope)}).`,
      );
    } else {
      changes.push(`Removed ${pathLabel}.perSession (${pathLabel}.scope already set).`);
    }
    delete sandbox.perSession;
  } else {
    // Preserve invalid values so normal schema validation still surfaces the
    // type error instead of silently falling back to the default sandbox scope.
    return;
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.sandbox.perSession->scope",
    describe: "Move legacy agent sandbox perSession aliases to sandbox.scope",
    legacyRules: LEGACY_SANDBOX_SCOPE_RULES,
    apply: (raw, changes) => {
      const agents = getRecord(raw.agents);
      const defaults = getRecord(agents?.defaults);
      const defaultSandbox = getRecord(defaults?.sandbox);
      if (defaultSandbox) {
        migrateLegacySandboxPerSession(defaultSandbox, "agents.defaults.sandbox", changes);
      }

      if (!Array.isArray(agents?.list)) {
        return;
      }
      for (const [index, agent] of agents.list.entries()) {
        const agentRecord = getRecord(agent);
        const sandbox = getRecord(agentRecord?.sandbox);
        if (!sandbox) {
          continue;
        }
        migrateLegacySandboxPerSession(sandbox, `agents.list.${index}.sandbox`, changes);
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    describe: "Move legacy x_search auth into the xAI plugin webSearch config",
    legacyRules: [X_SEARCH_RULE],
    apply: (raw, changes) => {
      const migrated = migrateLegacyXSearchConfig(raw);
      if (!migrated.changes.length) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
  defineLegacyConfigMigration({
    // v2026.2.26 added a startup guard requiring gateway.controlUi.allowedOrigins (or the
    // host-header fallback flag) for any non-loopback bind. The setup wizard was updated
    // to seed this for new installs, but existing bind=lan/bind=custom installs that upgrade
    // crash-loop immediately on next startup with no recovery path (issue #29385).
    //
    // Doctor-only migration path. Runtime now stops and points users to doctor before startup.
    id: "gateway.controlUi.allowedOrigins-seed-for-non-loopback",
    describe: "Seed gateway.controlUi.allowedOrigins for existing non-loopback gateway installs",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bind = gateway.bind;
      if (!isGatewayNonLoopbackBindMode(bind)) {
        return;
      }
      const controlUi = getRecord(gateway.controlUi) ?? {};
      if (
        hasConfiguredControlUiAllowedOrigins({
          allowedOrigins: controlUi.allowedOrigins,
          dangerouslyAllowHostHeaderOriginFallback:
            controlUi.dangerouslyAllowHostHeaderOriginFallback,
        })
      ) {
        return;
      }
      const port = resolveGatewayPortWithDefault(gateway.port, DEFAULT_GATEWAY_PORT);
      const origins = buildDefaultControlUiAllowedOrigins({
        port,
        bind,
        customBindHost:
          typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined,
      });
      gateway.controlUi = { ...controlUi, allowedOrigins: origins };
      raw.gateway = gateway;
      changes.push(
        `Seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} for bind=${String(bind)}. ` +
          "Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.",
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "memorySearch->agents.defaults.memorySearch",
    describe: "Move top-level memorySearch to agents.defaults.memorySearch",
    legacyRules: [MEMORY_SEARCH_RULE],
    apply: (raw, changes) => {
      const legacyMemorySearch = getRecord(raw.memorySearch);
      if (!legacyMemorySearch) {
        return;
      }

      mergeLegacyIntoDefaults({
        raw,
        rootKey: "agents",
        fieldKey: "memorySearch",
        legacyValue: legacyMemorySearch,
        changes,
        movedMessage: "Moved memorySearch → agents.defaults.memorySearch.",
        mergedMessage:
          "Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).",
      });
      delete raw.memorySearch;
    },
  }),
  defineLegacyConfigMigration({
    id: "gateway.bind.host-alias->bind-mode",
    describe: "Normalize gateway.bind host aliases to supported bind modes",
    legacyRules: [GATEWAY_BIND_RULE],
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bindRaw = gateway.bind;
      if (typeof bindRaw !== "string") {
        return;
      }

      const normalized = bindRaw.trim().toLowerCase();
      let mapped: "lan" | "loopback" | undefined;
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "*"
      ) {
        mapped = "lan";
      } else if (
        normalized === "127.0.0.1" ||
        normalized === "localhost" ||
        normalized === "::1" ||
        normalized === "[::1]"
      ) {
        mapped = "loopback";
      }

      if (!mapped || normalized === mapped) {
        return;
      }

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
    },
  }),
  defineLegacyConfigMigration({
    id: "tts.providers-generic-shape",
    describe: "Move legacy bundled TTS config keys into messages.tts.providers",
    legacyRules: LEGACY_TTS_RULES,
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      migrateLegacyTtsConfig(getRecord(messages?.tts), "messages.tts", changes);

      const plugins = getRecord(raw.plugins);
      const pluginEntries = getRecord(plugins?.entries);
      if (!pluginEntries) {
        return;
      }
      for (const [pluginId, entryValue] of Object.entries(pluginEntries)) {
        if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
          continue;
        }
        const entry = getRecord(entryValue);
        const config = getRecord(entry?.config);
        migrateLegacyTtsConfig(
          getRecord(config?.tts),
          `plugins.entries.${pluginId}.config.tts`,
          changes,
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "heartbeat->agents.defaults.heartbeat",
    describe: "Move top-level heartbeat to agents.defaults.heartbeat/channels.defaults.heartbeat",
    legacyRules: [HEARTBEAT_RULE],
    apply: (raw, changes) => {
      const legacyHeartbeat = getRecord(raw.heartbeat);
      if (!legacyHeartbeat) {
        return;
      }

      const { agentHeartbeat, channelHeartbeat } = splitLegacyHeartbeat(legacyHeartbeat);

      if (agentHeartbeat) {
        mergeLegacyIntoDefaults({
          raw,
          rootKey: "agents",
          fieldKey: "heartbeat",
          legacyValue: agentHeartbeat,
          changes,
          movedMessage: "Moved heartbeat → agents.defaults.heartbeat.",
          mergedMessage:
            "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
        });
      }

      if (channelHeartbeat) {
        mergeLegacyIntoDefaults({
          raw,
          rootKey: "channels",
          fieldKey: "heartbeat",
          legacyValue: channelHeartbeat,
          changes,
          movedMessage: "Moved heartbeat visibility → channels.defaults.heartbeat.",
          mergedMessage:
            "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
        });
      }

      if (!agentHeartbeat && !channelHeartbeat) {
        changes.push("Removed empty top-level heartbeat.");
      }
      delete raw.heartbeat;
    },
  }),
];
