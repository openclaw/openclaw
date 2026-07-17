// Shares plugin config normalization helpers across control-plane paths.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultSlotIdForKey } from "./slots.js";

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
      authorization?: {
        requiredPolicies?: Array<{
          id: string;
          operations: Array<"tool.call" | "message.action" | "command.invoke">;
        }>;
      };
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
        allowAgentIdOverride?: boolean;
      };
      config?: unknown;
    }
  >;
};

/** Plugin id normalizer used while loading aliases or raw config. */
export type NormalizePluginId = (id: string) => string;

/** Default plugin id normalizer for already-canonical ids. */
export const identityNormalizePluginId: NormalizePluginId = (id) => id.trim();

function normalizeList(value: unknown, normalizePluginId: NormalizePluginId): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? normalizePluginId(entry) : ""))
    .filter(Boolean);
}

function normalizeSlotValue(value: unknown): string | null | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (normalizeOptionalLowercaseString(trimmed) === "none") {
    return null;
  }
  return trimmed;
}

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 600_000
  ) {
    return undefined;
  }
  return value;
}

function normalizeHookTimeouts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

const AUTHORIZATION_OPERATIONS = new Set(["tool.call", "message.action", "command.invoke"]);

function normalizeRequiredAuthorizationPolicies(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: Array<{
    id: string;
    operations: Array<"tool.call" | "message.action" | "command.invoke">;
  }> = [];
  const byId = new Map<string, (typeof normalized)[number]>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = normalizeOptionalString((entry as { id?: unknown }).id);
    const rawOperations = (entry as { operations?: unknown }).operations;
    if (!id || !Array.isArray(rawOperations)) {
      continue;
    }
    const operations = [...new Set(rawOperations)].filter(
      (operation): operation is "tool.call" | "message.action" | "command.invoke" =>
        typeof operation === "string" && AUTHORIZATION_OPERATIONS.has(operation),
    );
    if (operations.length > 0) {
      const existing = byId.get(id);
      if (existing) {
        existing.operations = [...new Set([...existing.operations, ...operations])];
      } else {
        const policy = { id, operations };
        normalized.push(policy);
        byId.set(id, policy);
      }
    }
  }
  return normalized;
}

function normalizePluginEntries(
  entries: unknown,
  normalizePluginId: NormalizePluginId,
): NormalizedPluginsConfig["entries"] {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }
  const normalized: NormalizedPluginsConfig["entries"] = {};
  for (const [key, value] of Object.entries(entries)) {
    const normalizedKey = normalizePluginId(key);
    if (!normalizedKey) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      normalized[normalizedKey] = {};
      continue;
    }
    const entry = value as Record<string, unknown>;
    const authorizationRaw = entry.authorization;
    const authorizationRecord =
      authorizationRaw && typeof authorizationRaw === "object" && !Array.isArray(authorizationRaw)
        ? (authorizationRaw as Record<string, unknown>)
        : undefined;
    const hasRequiredAuthorizationPoliciesConfig = Array.isArray(
      authorizationRecord?.requiredPolicies,
    );
    const requiredAuthorizationPolicies = normalizeRequiredAuthorizationPolicies(
      authorizationRecord?.requiredPolicies,
    );
    const authorization = hasRequiredAuthorizationPoliciesConfig
      ? { requiredPolicies: requiredAuthorizationPolicies ?? [] }
      : undefined;
    const hooksRaw = entry.hooks;
    const hooks =
      hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
        ? {
            allowPromptInjection: (hooksRaw as { allowPromptInjection?: unknown })
              .allowPromptInjection,
            allowConversationAccess: (hooksRaw as { allowConversationAccess?: unknown })
              .allowConversationAccess,
            timeoutMs: normalizeHookTimeoutMs((hooksRaw as { timeoutMs?: unknown }).timeoutMs),
            timeouts: normalizeHookTimeouts((hooksRaw as { timeouts?: unknown }).timeouts),
          }
        : undefined;
    const normalizedHooks =
      hooks &&
      (typeof hooks.allowPromptInjection === "boolean" ||
        typeof hooks.allowConversationAccess === "boolean" ||
        hooks.timeoutMs !== undefined ||
        hooks.timeouts !== undefined)
        ? {
            ...(typeof hooks.allowPromptInjection === "boolean"
              ? { allowPromptInjection: hooks.allowPromptInjection }
              : {}),
            ...(typeof hooks.allowConversationAccess === "boolean"
              ? { allowConversationAccess: hooks.allowConversationAccess }
              : {}),
            ...(hooks.timeoutMs !== undefined ? { timeoutMs: hooks.timeoutMs } : {}),
            ...(hooks.timeouts !== undefined ? { timeouts: hooks.timeouts } : {}),
          }
        : undefined;
    const subagentRaw = entry.subagent;
    const subagent =
      subagentRaw && typeof subagentRaw === "object" && !Array.isArray(subagentRaw)
        ? {
            allowModelOverride: (subagentRaw as { allowModelOverride?: unknown })
              .allowModelOverride,
            hasAllowedModelsConfig: Array.isArray(
              (subagentRaw as { allowedModels?: unknown }).allowedModels,
            ),
            allowedModels: Array.isArray((subagentRaw as { allowedModels?: unknown }).allowedModels)
              ? normalizeArrayBackedTrimmedStringList(
                  (subagentRaw as { allowedModels?: unknown }).allowedModels,
                )
              : undefined,
          }
        : undefined;
    const normalizedSubagent =
      subagent &&
      (typeof subagent.allowModelOverride === "boolean" ||
        subagent.hasAllowedModelsConfig ||
        (Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0))
        ? {
            ...(typeof subagent.allowModelOverride === "boolean"
              ? { allowModelOverride: subagent.allowModelOverride }
              : {}),
            ...(subagent.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
            ...(Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0
              ? { allowedModels: subagent.allowedModels }
              : {}),
          }
        : undefined;
    const llmRaw = entry.llm;
    const llm =
      llmRaw && typeof llmRaw === "object" && !Array.isArray(llmRaw)
        ? {
            allowModelOverride: (llmRaw as { allowModelOverride?: unknown }).allowModelOverride,
            hasAllowedModelsConfig: Array.isArray(
              (llmRaw as { allowedModels?: unknown }).allowedModels,
            ),
            allowedModels: Array.isArray((llmRaw as { allowedModels?: unknown }).allowedModels)
              ? normalizeArrayBackedTrimmedStringList(
                  (llmRaw as { allowedModels?: unknown }).allowedModels,
                )
              : undefined,
            allowAgentIdOverride: (llmRaw as { allowAgentIdOverride?: unknown })
              .allowAgentIdOverride,
          }
        : undefined;
    const normalizedLlm =
      llm &&
      (typeof llm.allowModelOverride === "boolean" ||
        llm.hasAllowedModelsConfig ||
        (Array.isArray(llm.allowedModels) && llm.allowedModels.length > 0) ||
        typeof llm.allowAgentIdOverride === "boolean")
        ? {
            ...(typeof llm.allowModelOverride === "boolean"
              ? { allowModelOverride: llm.allowModelOverride }
              : {}),
            ...(llm.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
            ...(Array.isArray(llm.allowedModels) && llm.allowedModels.length > 0
              ? { allowedModels: llm.allowedModels }
              : {}),
            ...(typeof llm.allowAgentIdOverride === "boolean"
              ? { allowAgentIdOverride: llm.allowAgentIdOverride }
              : {}),
          }
        : undefined;
    normalized[normalizedKey] = {
      ...normalized[normalizedKey],
      enabled:
        typeof entry.enabled === "boolean" ? entry.enabled : normalized[normalizedKey]?.enabled,
      authorization: authorization ?? normalized[normalizedKey]?.authorization,
      hooks: normalizedHooks ?? normalized[normalizedKey]?.hooks,
      subagent: normalizedSubagent ?? normalized[normalizedKey]?.subagent,
      llm: normalizedLlm ?? normalized[normalizedKey]?.llm,
      config: "config" in entry ? entry.config : normalized[normalizedKey]?.config,
    };
  }
  return normalized;
}

/** Normalizes plugin config while allowing callers to resolve aliases first. */
export function normalizePluginsConfigWithResolver(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow, normalizePluginId),
    deny: normalizeList(config?.deny, normalizePluginId),
    loadPaths: normalizeList(config?.load?.paths, identityNormalizePluginId),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
      contextEngine: normalizeSlotValue(config?.slots?.contextEngine),
    },
    entries: normalizePluginEntries(config?.entries, normalizePluginId),
  };
}

export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  if (typeof plugins.enabled === "boolean") {
    return true;
  }
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
    return true;
  }
  if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.slots && Object.keys(plugins.slots).length > 0) {
    return true;
  }
  if (plugins.entries && Object.keys(plugins.entries).length > 0) {
    return true;
  }
  return false;
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  if (!cfg) {
    return false;
  }
  const channelId = normalizeChatChannelId(pluginId);
  if (!channelId) {
    return false;
  }
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>).enabled === true;
}
