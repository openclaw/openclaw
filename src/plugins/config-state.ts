import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  BUNDLED_LEGACY_PLUGIN_ID_ALIASES,
  BUNDLED_PROVIDER_PLUGIN_ID_ALIASES,
} from "./bundled-capability-metadata.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import type { PluginKind, PluginOrigin } from "./types.js";

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginExplicitSelectionCause =
  | "enabled-in-config"
  | "bundled-channel-enabled-in-config"
  | "selected-memory-slot"
  | "selected-in-allowlist";

export type PluginActivationCause =
  | PluginExplicitSelectionCause
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "disabled-in-config"
  | "workspace-disabled-by-default"
  | "not-in-allowlist"
  | "enabled-by-effective-config"
  | "bundled-channel-configured"
  | "bundled-default-enablement"
  | "bundled-disabled-by-default";

export type PluginActivationState = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
};

type PluginActivationDecision = {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  cause?: PluginActivationCause;
  reason?: string;
};

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
};

export type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
  };
  entries: Record<
    string,
    {
      enabled?: boolean;
      hooks?: {
        allowPromptInjection?: boolean;
      };
      subagent?: {
        allowModelOverride?: boolean;
        allowedModels?: string[];
        hasAllowedModelsConfig?: boolean;
      };
      config?: unknown;
    }
  >;
};

export function normalizePluginId(id: string): string {
  const trimmed = id.trim();
  return (
    BUNDLED_LEGACY_PLUGIN_ID_ALIASES[trimmed] ??
    BUNDLED_PROVIDER_PLUGIN_ID_ALIASES[trimmed] ??
    trimmed
  );
}

const normalizeList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? normalizePluginId(entry) : ""))
    .filter(Boolean);
};

const normalizeSlotValue = (value: unknown): string | null | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "none") {
    return null;
  }
  return trimmed;
};

const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string> = {
  "enabled-in-config": "enabled in config",
  "bundled-channel-enabled-in-config": "channel enabled in config",
  "selected-memory-slot": "selected memory slot",
  "selected-in-allowlist": "selected in allowlist",
  "plugins-disabled": "plugins disabled",
  "blocked-by-denylist": "blocked by denylist",
  "disabled-in-config": "disabled in config",
  "workspace-disabled-by-default": "workspace plugin (disabled by default)",
  "not-in-allowlist": "not in allowlist",
  "enabled-by-effective-config": "enabled by effective config",
  "bundled-channel-configured": "channel configured",
  "bundled-default-enablement": "bundled default enablement",
  "bundled-disabled-by-default": "bundled (disabled by default)",
};

function resolvePluginActivationReason(
  cause?: PluginActivationCause,
  reason?: string,
): string | undefined {
  if (reason) {
    return reason;
  }
  return cause ? PLUGIN_ACTIVATION_REASON_BY_CAUSE[cause] : undefined;
}

function toPluginActivationState(decision: PluginActivationDecision): PluginActivationState {
  return {
    enabled: decision.enabled,
    activated: decision.activated,
    explicitlyEnabled: decision.explicitlyEnabled,
    source: decision.source,
    reason: resolvePluginActivationReason(decision.cause, decision.reason),
  };
}

const normalizePluginEntries = (entries: unknown): NormalizedPluginsConfig["entries"] => {
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
    const hooksRaw = entry.hooks;
    const hooks =
      hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
        ? {
            allowPromptInjection: (hooksRaw as { allowPromptInjection?: unknown })
              .allowPromptInjection,
          }
        : undefined;
    const normalizedHooks =
      hooks && typeof hooks.allowPromptInjection === "boolean"
        ? {
            allowPromptInjection: hooks.allowPromptInjection,
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
              ? ((subagentRaw as { allowedModels?: unknown }).allowedModels as unknown[])
                  .map((model) => (typeof model === "string" ? model.trim() : ""))
                  .filter(Boolean)
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
    normalized[normalizedKey] = {
      ...normalized[normalizedKey],
      enabled:
        typeof entry.enabled === "boolean" ? entry.enabled : normalized[normalizedKey]?.enabled,
      hooks: normalizedHooks ?? normalized[normalizedKey]?.hooks,
      subagent: normalizedSubagent ?? normalized[normalizedKey]?.subagent,
      config: "config" in entry ? entry.config : normalized[normalizedKey]?.config,
    };
  }
  return normalized;
};

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  const memorySlot = normalizeSlotValue(config?.slots?.memory);
  return {
    enabled: config?.enabled !== false,
    allow: normalizeList(config?.allow),
    deny: normalizeList(config?.deny),
    loadPaths: normalizeList(config?.load?.paths),
    slots: {
      memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
    },
    entries: normalizePluginEntries(config?.entries),
  };
};

export function createPluginActivationSource(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
}): PluginActivationConfigSource {
  return {
    plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
    rootConfig: params.config,
  };
}

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));

export const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) => {
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
};

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

function resolveExplicitPluginSelection(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { explicitlyEnabled: true, cause: "enabled-in-config" };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, cause: "bundled-channel-enabled-in-config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, cause: "selected-memory-slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { explicitlyEnabled: true, cause: "selected-in-allowlist" };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  const activationSource =
    params.activationSource ??
    createPluginActivationSource({
      config: params.rootConfig,
      plugins: params.config,
    });
  const explicitSelection = resolveExplicitPluginSelection({
    id: params.id,
    origin: params.origin,
    config: activationSource.plugins,
    rootConfig: activationSource.rootConfig,
  });

  if (!params.config.enabled) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "plugins-disabled",
    });
  }
  if (params.config.deny.includes(params.id)) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "blocked-by-denylist",
    });
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "disabled-in-config",
    });
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (params.origin === "workspace" && !explicitlyAllowed && entry?.enabled !== true) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "workspace-disabled-by-default",
    });
  }
  if (params.config.slots.memory === params.id) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: "selected-memory-slot",
    });
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
      cause: "not-in-allowlist",
    });
  }
  if (explicitSelection.explicitlyEnabled) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
      cause: explicitSelection.cause,
    });
  }
  if (params.autoEnabledReason) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      reason: params.autoEnabledReason,
    });
  }
  if (entry?.enabled === true) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "enabled-by-effective-config",
    });
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "auto",
      cause: "bundled-channel-configured",
    });
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return toPluginActivationState({
      enabled: true,
      activated: true,
      explicitlyEnabled: false,
      source: "default",
      cause: "bundled-default-enablement",
    });
  }
  if (params.origin === "bundled") {
    return toPluginActivationState({
      enabled: false,
      activated: false,
      explicitlyEnabled: false,
      source: "disabled",
      cause: "bundled-disabled-by-default",
    });
  }
  return toPluginActivationState({
    enabled: true,
    activated: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  });
}

export function resolveEnableState(
  id: string,
  origin: PluginOrigin,
  config: NormalizedPluginsConfig,
  enabledByDefault?: boolean,
): { enabled: boolean; reason?: string } {
  const state = resolvePluginActivationState({
    id,
    origin,
    config,
    enabledByDefault,
  });
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
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

export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
}): { enabled: boolean; reason?: string } {
  const state = resolveEffectivePluginActivationState(params);
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string | string[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  if (!hasKind(params.kind as PluginKind | PluginKind[] | undefined, "memory")) {
    return { enabled: true };
  }
  // A dual-kind plugin (e.g. ["memory", "context-engine"]) that lost the
  // memory slot must stay enabled so its other slot role can still load.
  const isMultiKind = Array.isArray(params.kind) && params.kind.length > 1;
  if (params.slot === null) {
    return isMultiKind ? { enabled: true } : { enabled: false, reason: "memory slot disabled" };
  }
  if (typeof params.slot === "string") {
    if (params.slot === params.id) {
      return { enabled: true, selected: true };
    }
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot set to "${params.slot}"` };
  }
  if (params.selectedId && params.selectedId !== params.id) {
    return isMultiKind
      ? { enabled: true }
      : { enabled: false, reason: `memory slot already filled by "${params.selectedId}"` };
  }
  return { enabled: true, selected: true };
}
