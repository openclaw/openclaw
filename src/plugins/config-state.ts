import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Normalizes plugin config and resolves effective enablement, slots, and activation sources. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveMemorySlotDecisionShared,
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationConfigSourceLike,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  normalizePluginsConfigWithResolverCore,
  resolveChannelConfigEnablement,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { defaultSlotIdForKey } from "./slots.js";

export type PluginActivationState = PluginActivationStateLike;

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
} & PluginActivationConfigSourceLike<OpenClawConfig>;

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

const BUILT_IN_PLUGIN_ALIAS_LOOKUP = new Map<string, string>([
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
]);
const RETIRED_PLUGIN_IDS = new Set([
  "google-antigravity-auth",
  "google-gemini-cli-auth",
  "skill-workshop",
  "webhooks",
]);

/** Normalizes user/config plugin ids into the canonical lowercase key form. */
export function normalizePluginId(id: string): string {
  const normalized = normalizeOptionalLowercaseString(id) ?? "";
  return BUILT_IN_PLUGIN_ALIAS_LOOKUP.get(normalized) ?? normalized;
}

export function isRetiredPluginId(id: string): boolean {
  return RETIRED_PLUGIN_IDS.has(normalizePluginId(id));
}

/** Identifies the credential-free marker that records an explicit plugin disable decision. */
export function isExplicitPluginDisableMarker(value: unknown): boolean {
  return isRecord(value) && value.enabled === false && Object.keys(value).length === 1;
}

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  return normalizePluginsConfigWithResolverCore(config, normalizePluginId);
};

export type ContextEngineOwnerMetadata = {
  id: string;
  contextEngineIds?: readonly string[];
};

/** Resolves engine ownership before applying the owning plugin's activation policy. */
export function resolveSelectedContextEnginePluginId(
  config: OpenClawConfig | undefined,
  records: readonly ContextEngineOwnerMetadata[],
): string | undefined {
  const plugins = normalizePluginsConfig(config?.plugins);
  return resolveSelectedContextEnginePluginIdFromConfig(
    plugins,
    plugins.slots.contextEngine,
    records,
  );
}

function isContextEngineOwnerEligible(
  plugins: NormalizedPluginsConfig,
  pluginId: string,
  normalizedEngineId: string,
): boolean {
  if (
    !plugins.enabled ||
    !pluginId ||
    plugins.deny.includes(pluginId) ||
    plugins.entries[pluginId]?.enabled === false
  ) {
    return false;
  }
  // Equal-ID slots retain their explicit-selection exception to the allowlist.
  return (
    pluginId === normalizedEngineId ||
    ((plugins.entries[pluginId]?.enabled === true || plugins.allow.includes(pluginId)) &&
      (plugins.allow.length === 0 || plugins.allow.includes(pluginId)))
  );
}

/** Declared owners participate in selection and collision checks only when policy permits them. */
export function resolveEligibleContextEngineDeclaredOwners(
  plugins: NormalizedPluginsConfig,
  engineId: string | null | undefined,
  records: readonly ContextEngineOwnerMetadata[],
  normalizeId: (id: string) => string = normalizePluginId,
): { hasDeclarations: boolean; pluginIds: string[] } {
  const declared = records.filter(
    (record) => engineId && record.contextEngineIds?.includes(engineId),
  );
  const normalizedEngineId = engineId ? normalizeId(engineId) : undefined;
  return {
    hasDeclarations: declared.length > 0,
    pluginIds: normalizedEngineId
      ? [...new Set(declared.map((record) => normalizeId(record.id)))].filter((pluginId) =>
          isContextEngineOwnerEligible(plugins, pluginId, normalizedEngineId),
        )
      : [],
  };
}

export function resolveSelectedContextEnginePluginIdFromConfig(
  plugins: NormalizedPluginsConfig,
  engineId: string | null | undefined,
  records: readonly ContextEngineOwnerMetadata[],
  normalizeId: (id: string) => string = normalizePluginId,
): string | undefined {
  if (!plugins.enabled || !engineId || engineId === defaultSlotIdForKey("contextEngine")) {
    return undefined;
  }
  const owners = resolveEligibleContextEngineDeclaredOwners(
    plugins,
    engineId,
    records,
    normalizeId,
  );
  // Eligible declared owners take precedence over legacy equal-ID ownership.
  if (owners.pluginIds.length > 0) {
    return owners.pluginIds.length === 1 ? owners.pluginIds[0] : undefined;
  }
  const pluginId = normalizeId(engineId);
  // Unapproved declarations cannot veto an independently approved legacy owner,
  // but their presence must not grant an incidental same-named plugin authority.
  if (
    owners.hasDeclarations &&
    plugins.entries[pluginId]?.enabled !== true &&
    !plugins.allow.includes(pluginId)
  ) {
    return undefined;
  }
  const legacyOwner = records.find((record) => normalizeId(record.id) === pluginId);
  return legacyOwner &&
    legacyOwner.contextEngineIds === undefined &&
    isContextEngineOwnerEligible(plugins, pluginId, pluginId)
    ? pluginId
    : undefined;
}

/** Carries prepared ownership without changing the registered engine selector. */
export function withContextEngineOwner(
  plugins: NormalizedPluginsConfig,
  records: readonly ContextEngineOwnerMetadata[],
  normalizeId: (id: string) => string = normalizePluginId,
): NormalizedPluginsConfig {
  return {
    ...plugins,
    contextEngineOwnerId:
      resolveSelectedContextEnginePluginIdFromConfig(
        plugins,
        plugins.slots.contextEngine,
        records,
        normalizeId,
      ) ?? null,
  };
}

/** Canonicalizes one plugin entry and its policy-list ids before a targeted mutation. */
export function normalizePluginTargetConfig(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const normalizedId = normalizePluginId(pluginId);
  const normalized = normalizePluginsConfig(config.plugins);
  const rawEntries = config.plugins?.entries ?? {};
  const hasTargetEntry = Object.keys(rawEntries).some(
    (entryId) => normalizePluginId(entryId) === normalizedId,
  );
  const entries = Object.fromEntries(
    Object.entries(rawEntries).filter(([entryId]) => normalizePluginId(entryId) !== normalizedId),
  );
  if (hasTargetEntry) {
    const { config: pluginConfig, ...entry } = normalized.entries[normalizedId] ?? {};
    entries[normalizedId] = {
      // Auth/setup compares this authored candidate after it is persisted as JSON.
      // Absent optional runtime fields must not become non-round-trippable own keys.
      ...Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
      ...(isRecord(pluginConfig) ? { config: pluginConfig } : {}),
    };
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      ...(Array.isArray(config.plugins?.allow) ? { allow: normalized.allow } : {}),
      ...(Array.isArray(config.plugins?.deny) ? { deny: normalized.deny } : {}),
      entries,
    },
  };
}

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
  Boolean(plugins?.slots && Object.hasOwn(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.hasOwn(plugins.entries, defaultSlotIdForKey("memory")));

export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  return (
    typeof plugins.enabled === "boolean" ||
    (Array.isArray(plugins.allow) && plugins.allow.length > 0) ||
    (Array.isArray(plugins.deny) && plugins.deny.length > 0) ||
    (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) ||
    Boolean(plugins.slots && Object.keys(plugins.slots).length > 0) ||
    Boolean(plugins.entries && Object.keys(plugins.entries).length > 0)
  );
}

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig && (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins))) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...plugins,
      ...(!explicitConfig ? { enabled: false } : {}),
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
  return (
    Boolean(env.VITEST) &&
    !hasExplicitMemorySlot(cfg.plugins) &&
    !hasExplicitMemoryEntry(cfg.plugins)
  );
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
  channelIds?: readonly string[];
}): PluginActivationState {
  return toPluginActivationState(
    resolvePluginActivationDecisionShared({
      ...params,
      allowBundledChannelExplicitBypassesAllowlist: true,
      resolveChannelConfigEnablement,
    }),
  );
}

function toEnableStateResult(state: PluginActivationState): { enabled: boolean; reason?: string } {
  return state.enabled ? { enabled: true } : { enabled: false, reason: state.reason };
}

export const resolveEnableState = (
  id: string,
  origin: PluginOrigin,
  config: NormalizedPluginsConfig,
  enabledByDefault?: boolean,
): { enabled: boolean; reason?: string } =>
  toEnableStateResult(
    resolveEffectivePluginActivationState({ id, origin, config, enabledByDefault }),
  );

export const resolveEffectiveEnableState = (
  params: Omit<Parameters<typeof resolveEffectivePluginActivationState>[0], "autoEnabledReason">,
): { enabled: boolean; reason?: string } =>
  toEnableStateResult(resolveEffectivePluginActivationState(params));

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string | string[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
