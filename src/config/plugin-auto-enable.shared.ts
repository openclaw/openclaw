import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { getConfiguredDecisionProviderIds } from "../agents/decision-model-setting.js";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { collectConfiguredSpeechProviderIds } from "../plugins/gateway-startup-speech-providers.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isNativeSessionCatalogOptOutOnly } from "../plugins/native-session-catalog-config.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOwningPluginIdsForModelRef } from "../plugins/providers.js";
import { resolvePluginSetupAutoEnableReasons } from "../plugins/setup-registry.js";
import { collectConfiguredWorkerProviderIds } from "../plugins/worker-provider-config.js";
import { listBundledWorkerProviderOwners } from "../plugins/worker-provider-manifest.js";
import { isKernelOwnedChannelConfigKey } from "./channel-config-keys.js";
import {
  collectAutoEnableChannelIds,
  resolveConfiguredChannelAutoEnableCandidates,
  type ConfiguredPluginAutoEnableParams,
} from "./plugin-auto-enable.channels.js";
import { hasMaterialPluginEntryConfig } from "./plugin-auto-enable.materialize.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import { resolveConfiguredTalkRealtimeProviderId } from "./talk.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const EMPTY_PLUGIN_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};

function resolveAutoEnableProviderPluginIds(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  const entries = new Map<string, string>();
  for (const plugin of registry.plugins) {
    for (const providerId of plugin.autoEnableWhenConfiguredProviders ?? []) {
      if (!entries.has(providerId)) {
        entries.set(providerId, plugin.id);
      }
    }
  }
  return Object.fromEntries(entries);
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function resolveAgentHarnessOwnerPluginIds(
  registry: PluginManifestRegistry,
  runtime: string,
): string[] {
  const normalizedRuntime = normalizeOptionalLowercaseString(runtime);
  if (!normalizedRuntime) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      [...(plugin.activation?.onAgentHarnesses ?? []), ...(plugin.cliBackends ?? [])].some(
        (entry) => normalizeOptionalLowercaseString(entry) === normalizedRuntime,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  const profiles = cfg.auth?.profiles;
  if (
    profiles &&
    typeof profiles === "object" &&
    Object.values(profiles).some(
      (profile) => isRecord(profile) && normalizeProviderId(profile.provider ?? "") === normalized,
    )
  ) {
    return true;
  }

  const providerConfig = cfg.models?.providers;
  if (
    providerConfig &&
    typeof providerConfig === "object" &&
    Object.keys(providerConfig).some((key) => normalizeProviderId(key) === normalized)
  ) {
    return true;
  }

  return collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false }).some(
    ({ value: ref }) => {
      const provider = extractProviderFromModelRef(ref);
      return Boolean(provider) && provider === normalized;
    },
  );
}

function hasPluginOwnedToolConfig(cfg: OpenClawConfig, plugin: PluginManifestRecord): boolean {
  const entry = cfg.plugins?.entries?.[plugin.id];
  const pluginConfig = entry?.config;
  if (isNativeSessionCatalogOptOutOnly(plugin.id, entry) || !isRecord(pluginConfig)) {
    return false;
  }
  const properties = isRecord(plugin.configSchema) ? plugin.configSchema.properties : undefined;
  return (
    isRecord(properties) &&
    Object.keys(properties).some(
      (key) => key !== "webSearch" && key !== "webFetch" && pluginConfig[key] !== undefined,
    )
  );
}

function resolvePluginIdsForConfiguredSpeechProvider(
  providerId: string,
  registry: PluginManifestRegistry,
): string[] {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  return registry.plugins
    .filter((plugin) =>
      (plugin.contracts?.speechProviders ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolvePluginIdForConfiguredWebProvider(
  providerId: string | undefined,
  registry: PluginManifestRegistry,
  contract: "webSearchProviders" | "webFetchProviders",
): string | undefined {
  const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  return registry.plugins.find(
    (plugin) =>
      (contract !== "webFetchProviders" || plugin.origin === "bundled") &&
      (plugin.contracts?.[contract] ?? []).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId,
      ),
  )?.id;
}

function hasConfiguredWebSearchProviderSelection(cfg: OpenClawConfig): boolean {
  const provider = cfg.tools?.web?.search?.provider;
  return (
    cfg.tools?.web?.search?.enabled !== false &&
    typeof provider === "string" &&
    Boolean(provider.trim())
  );
}

function hasConfiguredVoiceProviderSelection(cfg: OpenClawConfig): boolean {
  return Boolean(
    collectConfiguredSpeechProviderIds(cfg).size || resolveConfiguredTalkRealtimeProviderId(cfg),
  );
}

function hasConfiguredPluginConfigEntry(cfg: OpenClawConfig): boolean {
  return Object.values(asOptionalObjectRecord(cfg.plugins?.entries) ?? {}).some(
    (entry) => isRecord(entry) && isRecord(entry.config),
  );
}

function listContainsNormalized(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeOptionalLowercaseString(entry) === expected)
  );
}

function toolPolicyReferencesBrowser(value: unknown): boolean {
  return (
    isRecord(value) &&
    (listContainsNormalized(value.allow, "browser") ||
      listContainsNormalized(value.alsoAllow, "browser"))
  );
}

function hasBrowserToolReference(cfg: OpenClawConfig): boolean {
  return (
    toolPolicyReferencesBrowser(cfg.tools) ||
    listAgentEntries(cfg).some((entry) => toolPolicyReferencesBrowser(entry.tools))
  );
}

function collectConfiguredPluginEntryIds(cfg: OpenClawConfig): string[] {
  return Object.keys(asOptionalObjectRecord(cfg.plugins?.entries) ?? {})
    .map((pluginId) => pluginId.trim())
    .filter((pluginId) => pluginId && !isPluginEntryExplicitlyDisabled(cfg, pluginId));
}

function isPluginEntryExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function hasBrowserSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (cfg.browser?.enabled === false || isPluginEntryExplicitlyDisabled(cfg, "browser")) {
    return false;
  }
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return (
    isRecord(cfg.browser) ||
    (entries !== undefined && Object.hasOwn(entries, "browser")) ||
    hasBrowserToolReference(cfg)
  );
}

function hasAcpxSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "acpx") || !isRecord(cfg.acp)) {
    return false;
  }
  const backend = normalizeOptionalLowercaseString(cfg.acp.backend);
  const configured =
    cfg.acp.enabled === true ||
    (isRecord(cfg.acp.dispatch) && cfg.acp.dispatch.enabled === true) ||
    backend === "acpx";
  return configured && (!backend || backend === "acpx");
}

function hasXaiSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  if (isPluginEntryExplicitlyDisabled(cfg, "xai")) {
    return false;
  }
  const pluginConfig = cfg.plugins?.entries?.xai?.config;
  return (
    isRecord(pluginConfig) &&
    (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))
  );
}

function resolveRelevantSetupAutoEnablePluginIds(cfg: OpenClawConfig): string[] {
  const pluginIds = new Set<string>(collectConfiguredPluginEntryIds(cfg));
  if (hasBrowserSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("browser");
  }
  if (hasAcpxSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("acpx");
  }
  if (hasXaiSetupAutoEnableRelevantConfig(cfg)) {
    pluginIds.add("xai");
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function hasSetupAutoEnableRelevantConfig(cfg: OpenClawConfig): boolean {
  return (
    hasBrowserSetupAutoEnableRelevantConfig(cfg) ||
    hasAcpxSetupAutoEnableRelevantConfig(cfg) ||
    hasXaiSetupAutoEnableRelevantConfig(cfg) ||
    hasConfiguredPluginConfigEntry(cfg)
  );
}

function hasPluginAllowlistWithMaterialEntries(cfg: OpenClawConfig): boolean {
  if (!Array.isArray(cfg.plugins?.allow) || cfg.plugins.allow.length === 0) {
    return false;
  }
  const entries = asOptionalObjectRecord(cfg.plugins?.entries);
  return entries !== undefined && Object.values(entries).some(hasMaterialPluginEntryConfig);
}

function hasConfiguredProviderModelOrHarness(cfg: OpenClawConfig): boolean {
  return (
    getConfiguredDecisionProviderIds(cfg).length > 0 ||
    Object.keys(cfg.auth?.profiles ?? {}).length > 0 ||
    Object.keys(cfg.models?.providers ?? {}).length > 0 ||
    collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false }).length > 0 ||
    collectConfiguredAgentHarnessRuntimes(cfg).length > 0
  );
}

function hasConfiguredPluginProviders(cfg: OpenClawConfig): boolean {
  return (
    hasConfiguredProviderModelOrHarness(cfg) ||
    hasConfiguredVoiceProviderSelection(cfg) ||
    collectConfiguredWorkerProviderIds(cfg).length > 0 ||
    hasConfiguredWebSearchProviderSelection(cfg)
  );
}

function configMayNeedPluginManifestRegistry(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return false;
  }
  if (
    hasPluginAllowlistWithMaterialEntries(cfg) ||
    hasConfiguredPluginConfigEntry(cfg) ||
    hasConfiguredPluginProviders(cfg)
  ) {
    return true;
  }
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return false;
  }
  return Object.keys(configuredChannels).some((key) => !isKernelOwnedChannelConfigKey(key));
}

export function configMayNeedPluginAutoEnable(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  return resolvePluginAutoEnableReadiness(cfg, env).mayNeedAutoEnable;
}

export function resolvePluginAutoEnableReadiness(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers?: AmbientEnvTriggerPolicy,
): { mayNeedAutoEnable: boolean; configuredChannelIds: string[] } {
  if (cfg.plugins?.enabled === false) {
    return { mayNeedAutoEnable: false, configuredChannelIds: [] };
  }
  const configuredChannelIds = collectAutoEnableChannelIds(cfg, env, discovery, ambientEnvTriggers);
  return {
    mayNeedAutoEnable:
      hasPluginAllowlistWithMaterialEntries(cfg) ||
      hasConfiguredPluginConfigEntry(cfg) ||
      configuredChannelIds.length > 0 ||
      hasConfiguredPluginProviders(cfg) ||
      (hasSetupAutoEnableRelevantConfig(cfg) &&
        resolvePluginSetupAutoEnableReasons({
          config: cfg,
          env,
          pluginIds: resolveRelevantSetupAutoEnablePluginIds(cfg),
        }).length > 0),
    configuredChannelIds,
  };
}

export function resolveConfiguredPluginAutoEnableCandidates(
  params: ConfiguredPluginAutoEnableParams,
): PluginAutoEnableCandidate[] {
  const changes = resolveConfiguredChannelAutoEnableCandidates(params);

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(params.registry),
  )) {
    if (isProviderConfigured(params.config, providerId)) {
      changes.push({ pluginId, kind: "provider-auth-configured", providerId });
    }
  }

  const configuredModelPluginIds = new Set<string>();
  for (const modelRef of new Set(
    collectConfiguredModelRefs(params.config, { includeChannelModelOverrides: false }).map(
      ({ value }) => value,
    ),
  )) {
    const owningPluginIds = resolveOwningPluginIdsForModelRef({
      model: modelRef,
      config: params.config,
      env: params.env,
      manifestRegistry: params.registry,
    });
    const pluginId = owningPluginIds?.length === 1 ? owningPluginIds[0] : undefined;
    if (!pluginId || configuredModelPluginIds.has(pluginId)) {
      continue;
    }
    configuredModelPluginIds.add(pluginId);
    changes.push({ pluginId, kind: "provider-model-configured", modelRef });
  }

  for (const providerId of collectConfiguredSpeechProviderIds(params.config)) {
    for (const pluginId of resolvePluginIdsForConfiguredSpeechProvider(
      providerId,
      params.registry,
    )) {
      changes.push({
        pluginId,
        kind: "speech-provider-selected",
        providerId,
      });
    }
  }

  const realtimeProviderId = resolveConfiguredTalkRealtimeProviderId(params.config);
  if (realtimeProviderId) {
    for (const plugin of params.registry.plugins) {
      if (!plugin.contracts?.realtimeVoiceProviders?.includes(realtimeProviderId.toLowerCase())) {
        continue;
      }
      changes.push({
        pluginId: plugin.id,
        kind: "setup-auto-enable",
        reason: `${realtimeProviderId} realtime voice provider selected`,
      });
    }
  }

  for (const { pluginId, providerId } of listBundledWorkerProviderOwners(
    params.registry,
    collectConfiguredWorkerProviderIds(params.config),
  )) {
    changes.push({ pluginId, kind: "worker-provider-selected", providerId });
  }

  const decisionProviderIds = new Set(getConfiguredDecisionProviderIds(params.config));
  for (const plugin of params.registry.plugins) {
    for (const providerId of plugin.contracts?.decisionProviders ?? []) {
      if (decisionProviderIds.has(providerId)) {
        changes.push({ pluginId: plugin.id, kind: "decision-provider-selected", providerId });
      }
    }
  }

  for (const runtime of collectConfiguredAgentHarnessRuntimes(params.config)) {
    const pluginIds = resolveAgentHarnessOwnerPluginIds(params.registry, runtime);
    for (const pluginId of pluginIds) {
      changes.push({
        pluginId,
        kind: "agent-harness-runtime-configured",
        runtime,
      });
    }
  }

  const webSearchConfig = params.config.tools?.web?.search;
  for (const [contract, kind, provider] of [
    [
      "webSearchProviders",
      "web-search-provider-selected",
      webSearchConfig?.enabled !== false ? webSearchConfig?.provider : undefined,
    ],
    ["webFetchProviders", "web-fetch-provider-selected", params.config.tools?.web?.fetch?.provider],
  ] as const) {
    const providerId = typeof provider === "string" ? provider : undefined;
    const pluginId = resolvePluginIdForConfiguredWebProvider(providerId, params.registry, contract);
    if (pluginId) {
      changes.push({
        pluginId,
        kind,
        providerId: normalizeOptionalLowercaseString(providerId) ?? "",
      });
    }
  }

  for (const [contract, configKey, kind] of [
    ["webSearchProviders", "webSearch", "plugin-web-search-configured"],
    ["tools", null, "plugin-tool-configured"],
    ["webFetchProviders", "webFetch", "plugin-web-fetch-configured"],
  ] as const) {
    for (const plugin of params.registry.plugins) {
      if (
        (plugin.contracts?.[contract]?.length ?? 0) === 0 ||
        (contract === "webSearchProviders" && (plugin.providers?.length ?? 0) === 0)
      ) {
        continue;
      }
      const config = params.config.plugins?.entries?.[plugin.id]?.config;
      const configured = configKey
        ? isRecord(config) && isRecord(config[configKey])
        : hasPluginOwnedToolConfig(params.config, plugin);
      if (configured) {
        changes.push({ pluginId: plugin.id, kind });
      }
    }
  }

  if (hasSetupAutoEnableRelevantConfig(params.config)) {
    const manifestMatchedPluginIds = new Set(changes.map((entry) => entry.pluginId));
    const setupPluginIds = resolveRelevantSetupAutoEnablePluginIds(params.config).filter(
      (pluginId) => !manifestMatchedPluginIds.has(pluginId),
    );
    for (const entry of resolvePluginSetupAutoEnableReasons({
      config: params.config,
      env: params.env,
      pluginIds: setupPluginIds,
      manifestRegistry: params.registry,
    })) {
      changes.push({
        pluginId: entry.pluginId,
        kind: "setup-auto-enable",
        reason: entry.reason,
      });
    }
  }

  return changes;
}

export function resolvePluginAutoEnableManifestRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  if (params.manifestRegistry) {
    return params.manifestRegistry;
  }
  if (!configMayNeedPluginManifestRegistry(params.config)) {
    return EMPTY_PLUGIN_MANIFEST_REGISTRY;
  }
  let snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!snapshot && normalizePluginsConfig(params.config.plugins).loadPaths.length === 0) {
    const candidate = getCurrentPluginMetadataSnapshot({
      env: params.env,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    if (candidate?.policyHash === resolveInstalledPluginIndexPolicyHash(params.config)) {
      snapshot = candidate;
    }
  }
  return (
    snapshot?.manifestRegistry ??
    loadPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
    }).manifestRegistry
  );
}
