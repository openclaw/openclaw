import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
  type AmbientEnvTriggerPolicy,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { listExplicitConfiguredChannelIdsForConfig } from "./channel-presence-policy.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import {
  resolveEffectivePluginActivationState,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { NormalizedPluginsConfig } from "./gateway-startup-plugin-contracts.js";
import {
  isConfigActivationValueEnabled,
  sortUniquePluginIds,
} from "./gateway-startup-plugin-contracts.js";
import {
  collectConfiguredGenerationProviderIds,
  collectConfiguredMemoryEmbeddingProviderIds,
  collectConfiguredVoiceProviderIds,
  collectConfiguredWebSearchProviderIds,
} from "./gateway-startup-plugin-providers.js";
import { collectConfiguredSpeechProviderIds } from "./gateway-startup-speech-providers.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
  InstalledPluginIndexScopeLookup,
} from "./installed-plugin-index-types.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

export function readStartupBundledDiscoveryMode(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): "compat" | "allowlist" | undefined {
  const stateMode = readBundledDiscoveryMode({ env });
  if (stateMode) {
    return stateMode;
  }
  // Bootstrap Doctor with the raw legacy marker before it has been imported
  // into SQLite; steady-state runtime consumers use machine state only.
  const legacyMode = (config.plugins as { bundledDiscovery?: unknown } | undefined)
    ?.bundledDiscovery;
  if (legacyMode === "compat" || legacyMode === "allowlist") {
    return legacyMode;
  }
  return undefined;
}

function listPotentialEnabledChannelIds(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ambientEnvTriggers?: AmbientEnvTriggerPolicy,
): string[] {
  const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(config));
  const enabledSignals = [
    ...listPotentialConfiguredChannelIds(config, env, {
      includePersistedAuthState: false,
      ambientEnvTriggers,
    }),
    ...listExplicitConfiguredChannelIdsForConfig(config),
  ]
    .map((id) => normalizeOptionalLowercaseString(id) ?? "")
    .filter((id) => id && !disabled.has(id));
  return sortUniquePluginIds(enabledSignals);
}

export function blocksPluginStartup(params: {
  pluginId: string;
  pluginsConfig: NormalizedPluginsConfig;
  activationSourcePlugins: NormalizedPluginsConfig;
}): boolean {
  const policyId = normalizePluginPolicyId(params.pluginId);
  return (
    params.pluginsConfig.deny.includes(policyId) ||
    params.activationSourcePlugins.deny.includes(policyId) ||
    params.pluginsConfig.entries[policyId]?.enabled === false ||
    params.activationSourcePlugins.entries[policyId]?.enabled === false
  );
}

export function resolveAuthorizedGatewayStartupDreamingPluginIds(params: {
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: {
    plugins: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
  };
  activationSourcePlugins: NormalizedPluginsConfig;
  selectedMemoryPluginId?: string;
  index: { plugins: readonly InstalledPluginIndexRecord[] };
  platform?: NodeJS.Platform;
}): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.config),
    cfg: params.config,
  });
  const dreamingSelectedPluginId = normalizeOptionalLowercaseString(
    resolveMemoryDreamingPluginId(params.config),
  );
  const engineId = DEFAULT_MEMORY_DREAMING_PLUGIN_ID;
  if (
    !dreamingConfig.enabled ||
    !dreamingSelectedPluginId ||
    dreamingSelectedPluginId === engineId ||
    !params.pluginsConfig.enabled ||
    !params.activationSourcePlugins.enabled
  ) {
    return new Set();
  }
  if (
    !params.selectedMemoryPluginId ||
    params.selectedMemoryPluginId !== dreamingSelectedPluginId ||
    params.selectedMemoryPluginId === engineId ||
    blocksPluginStartup({
      pluginId: engineId,
      pluginsConfig: params.pluginsConfig,
      activationSourcePlugins: params.activationSourcePlugins,
    })
  ) {
    return new Set();
  }
  const selectedPlugin = params.index.plugins.find(
    (plugin) => plugin.pluginId === params.selectedMemoryPluginId,
  );
  const sidecarPlugin = params.index.plugins.find((plugin) => plugin.pluginId === engineId);
  if (!selectedPlugin?.startup.memory || !sidecarPlugin?.startup.memory) {
    return new Set();
  }
  const activationState = resolveEffectivePluginActivationState({
    id: selectedPlugin.pluginId,
    origin: selectedPlugin.origin,
    channelIds: selectedPlugin.contributions?.channels,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(selectedPlugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled ? new Set([engineId]) : new Set();
}

export function resolveMemorySlotStartupPluginId(params: {
  activationSourceConfig: OpenClawConfig;
  activationSourcePlugins: NormalizedPluginsConfig;
  normalizePluginId: (pluginId: string) => string;
}): string | undefined {
  const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
  const configuredSlot = activationSourceConfig.plugins?.slots?.memory?.trim();
  if (configuredSlot?.toLowerCase() === "none") {
    return undefined;
  }
  if (!configuredSlot) {
    const defaultSlot = activationSourcePlugins.slots.memory;
    if (typeof defaultSlot !== "string") {
      return undefined;
    }
    if (
      activationSourcePlugins.allow.length > 0 &&
      !activationSourcePlugins.allow.includes(defaultSlot)
    ) {
      return undefined;
    }
    return defaultSlot;
  }
  return normalizePluginId(configuredSlot);
}

export function resolveContextEngineSlotStartupPluginId(params: {
  activationSourceConfig: OpenClawConfig;
  activationSourcePlugins: NormalizedPluginsConfig;
  normalizePluginId: (pluginId: string) => string;
}): string | undefined {
  const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
  const configuredSlot = activationSourceConfig.plugins?.slots?.contextEngine?.trim();
  if (!configuredSlot) {
    return undefined;
  }
  return resolveSelectedContextEnginePluginIdFromConfig(
    activationSourcePlugins,
    normalizePluginId(configuredSlot),
  );
}

export function shouldConsiderForGatewayStartup(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  startupDreamingPluginIds: ReadonlySet<string>;
  memorySlotStartupPluginId?: string;
  contextEngineSlotStartupPluginId?: string;
}): boolean {
  return (
    params.manifest?.activation?.onStartup === true ||
    params.contextEngineSlotStartupPluginId === params.plugin.pluginId ||
    (params.plugin.startup.memory &&
      (params.startupDreamingPluginIds.has(params.plugin.pluginId) ||
        params.memorySlotStartupPluginId === params.plugin.pluginId))
  );
}

export function hasConfiguredActivationPath(params: {
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
}): boolean {
  return hasConfiguredActivationPathPatterns({
    paths: params.manifest?.activation?.onConfigPaths,
    config: params.config,
  });
}

function hasConfiguredActivationPathPatterns(params: {
  paths: readonly string[] | undefined;
  config: OpenClawConfig;
}): boolean {
  const paths = params.paths;
  if (!paths?.length) {
    return false;
  }
  return paths.some((pathPattern) =>
    collectPluginConfigContractMatches({
      root: params.config,
      pathPattern,
    }).some((match) => isConfigActivationValueEnabled(match.value)),
  );
}

export function addConfiguredActivationPathPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    index: InstalledPluginIndex;
  },
): void {
  for (const plugin of params.index.plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (
      hasConfiguredActivationPathPatterns({
        paths: plugin.startup.configPaths,
        config: params.activationSourceConfig,
      })
    ) {
      target.add(plugin.pluginId);
    }
  }
}

export function addPluginConfigEntryIds(
  target: Set<string>,
  plugins: NormalizedPluginsConfig,
  normalizePluginId: (pluginId: string) => string,
): void {
  for (const [pluginId, entry] of Object.entries(plugins.entries)) {
    if (entry?.enabled !== false) {
      target.add(normalizePluginId(pluginId));
    }
  }
}

export function addConfiguredSlotPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    activationSourcePlugins: NormalizedPluginsConfig;
    lookup: InstalledPluginIndexScopeLookup;
  },
): void {
  for (const resolveSlot of [
    resolveMemorySlotStartupPluginId,
    resolveContextEngineSlotStartupPluginId,
  ]) {
    const pluginId = resolveSlot({
      activationSourceConfig: params.activationSourceConfig,
      activationSourcePlugins: params.activationSourcePlugins,
      normalizePluginId: params.lookup.normalizePluginId,
    });
    if (pluginId) {
      target.add(pluginId);
    }
  }
}

export function collectConfiguredStartupChannelIds(params: {
  configs: readonly OpenClawConfig[];
  env: NodeJS.ProcessEnv;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] {
  return sortUniquePluginIds(
    params.configs.flatMap((config) =>
      listPotentialEnabledChannelIds(config, params.env, params.ambientEnvTriggers),
    ),
  );
}

export function collectConfiguredProviderIds(config: OpenClawConfig): string[] {
  const configuredWebSearchProviderIds = collectConfiguredWebSearchProviderIds(config);
  const configuredGenerationProviderIds = collectConfiguredGenerationProviderIds(config);
  const configuredVoiceProviderIds = collectConfiguredVoiceProviderIds(config);
  return sortUniquePluginIds([
    ...collectConfiguredSpeechProviderIds(config),
    ...configuredWebSearchProviderIds,
    ...configuredGenerationProviderIds.imageGenerationProviders,
    ...configuredGenerationProviderIds.videoGenerationProviders,
    ...configuredGenerationProviderIds.musicGenerationProviders,
    ...configuredVoiceProviderIds.speechProviders,
    ...configuredVoiceProviderIds.realtimeTranscriptionProviders,
    ...configuredVoiceProviderIds.realtimeVoiceProviders,
    ...collectConfiguredMemoryEmbeddingProviderIds(config),
  ]);
}

export function collectValidationConfiguredRefs(config: OpenClawConfig) {
  const providerIds: string[] = [];
  const pushProviderId = (value: unknown) => {
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized) {
      providerIds.push(normalized);
    }
  };
  const profiles = config.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (isRecord(profile)) {
        pushProviderId(profile.provider);
      }
    }
  }
  const providers = config.models?.providers;
  if (providers && typeof providers === "object") {
    for (const providerId of Object.keys(providers)) {
      pushProviderId(providerId);
    }
  }
  const shorthandModelRefs: string[] = [];
  for (const ref of collectConfiguredModelRefs(config)) {
    const slashIndex = ref.value.indexOf("/");
    if (slashIndex > 0) {
      pushProviderId(ref.value.slice(0, slashIndex));
    } else if (slashIndex < 0) {
      shorthandModelRefs.push(ref.value);
    }
  }
  pushProviderId(config.tools?.web?.search?.provider);
  pushProviderId(config.tools?.web?.fetch?.provider);
  return { providerIds: sortUniquePluginIds(providerIds), shorthandModelRefs };
}

export function collectValidationConfiguredShorthandModelIds(
  modelRefs: readonly string[],
): string[] {
  return sortUniquePluginIds(
    modelRefs.map((ref) => splitTrailingAuthProfile(ref).model.trim()).filter(Boolean),
  );
}
