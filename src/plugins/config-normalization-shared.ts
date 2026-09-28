// Shares plugin config normalization helpers across control-plane paths.
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSlotValue, resolveSlotSelection } from "./slots.js";

/** Canonical plugin config shape consumed by runtime policy and loaders. */
export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<
    string,
    {
      enabled?: boolean;
      hooks?: {
        allowPromptInjection?: boolean;
        allowConversationAccess?: boolean;
        timeoutMs?: number;
        timeouts?: Record<string, number>;
      };
      subagent?: {
        allowModelOverride?: boolean;
        allowedModels?: string[];
        hasAllowedModelsConfig?: boolean;
      };
      llm?: {
        allowModelOverride?: boolean;
        allowedModels?: string[];
        hasAllowedModelsConfig?: boolean;
        allowedCompletionModels?: string[];
        hasAllowedCompletionModelsConfig?: boolean;
        allowAuthProfileOverride?: boolean;
        allowAgentIdOverride?: boolean;
      };
      config?: unknown;
    }
  >;
};

/** Plugin id normalizer used while loading aliases or raw config. */
export type NormalizePluginId = (id: string) => string;

/** Default plugin id normalizer for already-canonical ids. */
const identityNormalizePluginId: NormalizePluginId = (id) => id.trim();

export function normalizePluginConfigList(
  value: unknown,
  normalizePluginId: NormalizePluginId,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? normalizePluginId(entry) : ""))
    .filter(Boolean);
}

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 1, max: 600_000 });
}

function normalizeHookTimeouts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [hookName, timeoutMs] of Object.entries(value)) {
    const normalizedTimeoutMs = normalizeHookTimeoutMs(timeoutMs);
    if (normalizedTimeoutMs !== undefined) {
      normalized[hookName] = normalizedTimeoutMs;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

type NormalizedPluginEntry = NormalizedPluginsConfig["entries"][string];

function normalizePluginHooks(value: unknown): NormalizedPluginEntry["hooks"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const hooks: NonNullable<NormalizedPluginEntry["hooks"]> = {};
  for (const key of ["allowPromptInjection", "allowConversationAccess"] as const) {
    if (typeof value[key] === "boolean") {
      hooks[key] = value[key];
    }
  }
  const timeoutMs = normalizeHookTimeoutMs(value.timeoutMs);
  const timeouts = normalizeHookTimeouts(value.timeouts);
  if (timeoutMs !== undefined) {
    hooks.timeoutMs = timeoutMs;
  }
  if (timeouts !== undefined) {
    hooks.timeouts = timeouts;
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function normalizePluginModelConfig(
  value: unknown,
  kind: "subagent" | "llm",
): NormalizedPluginEntry["llm"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const config: NonNullable<NormalizedPluginEntry["llm"]> = {};
  if (typeof value.allowModelOverride === "boolean") {
    config.allowModelOverride = value.allowModelOverride;
  }
  for (const [key, configuredKey] of [
    ["allowedModels", "hasAllowedModelsConfig"],
    ["allowedCompletionModels", "hasAllowedCompletionModelsConfig"],
  ] as const) {
    if (key === "allowedCompletionModels" && kind !== "llm") {
      continue;
    }
    const models = normalizeArrayBackedTrimmedStringList(value[key]);
    if (models) {
      config[configuredKey] = true;
      if (models.length > 0) {
        config[key] = models;
      }
    }
  }
  if (kind === "llm") {
    for (const key of ["allowAuthProfileOverride", "allowAgentIdOverride"] as const) {
      if (typeof value[key] === "boolean") {
        config[key] = value[key];
      }
    }
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizePluginEntries(
  entries: unknown,
  normalizePluginId: NormalizePluginId,
): NormalizedPluginsConfig["entries"] {
  if (!isRecord(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    const normalizedKey = normalizePluginId(key);
    if (!normalizedKey) {
      continue;
    }
    if (!isRecord(value)) {
      normalized[normalizedKey] = {};
      continue;
    }
    const entry = value;
    normalized[normalizedKey] = {
      ...normalized[normalizedKey],
      enabled:
        typeof entry.enabled === "boolean" ? entry.enabled : normalized[normalizedKey]?.enabled,
      hooks: normalizePluginHooks(entry.hooks) ?? normalized[normalizedKey]?.hooks,
      subagent:
        normalizePluginModelConfig(entry.subagent, "subagent") ??
        normalized[normalizedKey]?.subagent,
      llm: normalizePluginModelConfig(entry.llm, "llm") ?? normalized[normalizedKey]?.llm,
      config: "config" in entry ? entry.config : normalized[normalizedKey]?.config,
    };
  }
  return normalized;
}

/** Normalizes plugin config while allowing callers to resolve aliases first. */
export function normalizePluginsConfigWithResolverCore(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  const memorySlot = resolveSlotSelection("memory", config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizePluginConfigList(config?.allow, normalizePluginId),
    deny: normalizePluginConfigList(config?.deny, normalizePluginId),
    loadPaths: normalizePluginConfigList(config?.load?.paths, identityNormalizePluginId),
    slots: {
      memory: memorySlot.kind === "off" ? null : memorySlot.pluginId,
      contextEngine: normalizeSlotValue(config?.slots?.contextEngine),
    },
    entries: normalizePluginEntries(config?.entries, normalizePluginId),
  };
}

/**
 * Enables an owner for any enabled channel; disables it only when all channels are off.
 * Unspecified channels leave the plugin's own activation policy in control.
 */
export function resolveChannelConfigEnablement(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
  channelIds: readonly string[] = [],
): boolean | undefined {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return undefined;
  }
  // Declared ownership is authoritative; infer from the plugin id only when absent.
  const candidateIds = channelIds.length
    ? channelIds.map((channelId) => normalizeChatChannelId(channelId) ?? channelId)
    : [normalizeChatChannelId(pluginId)];
  const enablement = candidateIds.map((channelId) => {
    const entry = channelId ? channels[channelId] : undefined;
    return isRecord(entry) ? entry.enabled : undefined;
  });
  if (enablement.includes(true)) {
    return true;
  }
  return enablement.every((enabled) => enabled === false) ? false : undefined;
}
