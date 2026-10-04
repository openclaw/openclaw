import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { isBundledProviderCompatPlugin } from "./bundled-provider-compat.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  blocksPluginStartup,
  hasConfiguredActivationPath,
} from "./gateway-startup-plugin-config.js";
import type {
  ConfiguredGenerationProviderIds,
  ConfiguredVoiceProviderIds,
  NormalizedPluginsConfig,
} from "./gateway-startup-plugin-contracts.js";
import { manifestOwnsConfiguredModelProvider } from "./gateway-startup-plugin-providers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { manifestOwnsStorageProvider } from "./storage-provider-manifest.js";
import { manifestOwnsWorkerProvider } from "./worker-provider-manifest.js";

type PluginStartupActivationParams = {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: { plugins: NormalizedPluginsConfig; rootConfig?: OpenClawConfig };
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

type GatewayStartupActivationParams = PluginStartupActivationParams & {
  manifest: PluginManifestRecord | undefined;
  requiredAgentHarnessRuntimes: ReadonlySet<string>;
  configuredWorkerProviderIds: ReadonlySet<string>;
  configuredStorageProviderIds: ReadonlySet<string>;
  configuredSpeechProviderIds: ReadonlySet<string>;
  configuredWebSearchProviderIds: ReadonlySet<string>;
  configuredModelProviderIds: ReadonlySet<string>;
  configuredGenerationProviderIds: ConfiguredGenerationProviderIds;
  configuredVoiceProviderIds: ConfiguredVoiceProviderIds;
  configuredMemoryEmbeddingProviderIds: ReadonlySet<string>;
  configuredDecisionProviderIds: ReadonlySet<string>;
};

type StartupActivationPolicy =
  | "provider"
  | "implicit-external"
  | "worker"
  | "storage"
  | "decision"
  | "speech"
  | "root"
  | "harness"
  | "hook"
  | "tool";
type StartupContractKey =
  | keyof ConfiguredGenerationProviderIds
  | keyof ConfiguredVoiceProviderIds
  | "embeddingProviders"
  | "decisionProviders"
  | "webSearchProviders";

export function addRequiredAgentHarnessPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    config: OpenClawConfig;
    index: InstalledPluginIndex;
    pluginsConfig: NormalizedPluginsConfig;
    activationSource: {
      plugins: NormalizedPluginsConfig;
      rootConfig?: OpenClawConfig;
    };
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): void {
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(params.activationSourceConfig, {
      includeImplicitRuntimePreferences: false,
    }),
  );
  if (requiredAgentHarnessRuntimes.size === 0) {
    return;
  }
  for (const plugin of params.index.plugins) {
    if (
      plugin.startup.agentHarnesses.some((runtime) => requiredAgentHarnessRuntimes.has(runtime)) &&
      passesPluginStartupPolicy({ ...params, plugin }, "harness")
    ) {
      target.add(plugin.pluginId);
    }
  }
}

function resolveStartupActivationState(
  params: PluginStartupActivationParams,
  autoEnabledReason?: string,
  applyBundledProviderCompat = false,
) {
  const config = applyBundledProviderCompat
    ? (withBundledPluginEnablementCompat({
        config: params.config,
        pluginIds: [params.plugin.pluginId],
        env: params.env,
        activation: "defaults",
      }) ?? params.config)
    : params.config;
  return resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    channelIds: params.plugin.contributions?.channels,
    config: applyBundledProviderCompat
      ? normalizePluginsConfig(config.plugins)
      : params.pluginsConfig,
    rootConfig: config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
    ...(autoEnabledReason ? { autoEnabledReason } : {}),
  });
}

function isProviderCompatStartupPolicy(policy: StartupActivationPolicy): boolean {
  return (
    policy === "provider" ||
    policy === "worker" ||
    policy === "storage" ||
    policy === "speech" ||
    policy === "implicit-external"
  );
}

function hasExplicitHookPolicyConfig(
  entry: NormalizedPluginsConfig["entries"][string] | undefined,
): boolean {
  return (
    entry?.hooks?.allowConversationAccess === true ||
    entry?.hooks?.allowPromptInjection === true ||
    entry?.hooks?.timeoutMs !== undefined ||
    (entry?.hooks?.timeouts !== undefined && Object.keys(entry.hooks.timeouts).length > 0)
  );
}

function passesPluginStartupPolicy(
  params: PluginStartupActivationParams,
  policy: StartupActivationPolicy,
): boolean {
  const { activationSource, plugin, pluginsConfig } = params;
  // Bundled speech contracts remain available even when global plugin activation is disabled.
  if (
    (policy !== "speech" && (!pluginsConfig.enabled || !activationSource.plugins.enabled)) ||
    blocksPluginStartup({
      pluginId: plugin.pluginId,
      pluginsConfig,
      activationSourcePlugins: activationSource.plugins,
    })
  ) {
    return false;
  }
  if (
    policy === "harness" &&
    [pluginsConfig, activationSource.plugins].some(
      (config) => config.allow.length > 0 && !config.allow.includes(plugin.pluginId),
    )
  ) {
    return false;
  }
  const bundled = plugin.origin === "bundled";
  // Authored harness/root intent and speech ownership activate bundled owners without defaults.
  if (bundled && (policy === "harness" || policy === "speech" || policy === "root")) {
    return true;
  }
  // External config-path owners require authored trust; ambient matching alone must not start them.
  if (
    policy === "root" &&
    activationSource.plugins.allow.length > 0 &&
    !activationSource.plugins.allow.includes(plugin.pluginId)
  ) {
    return false;
  }
  const activationState = resolveStartupActivationState(
    params,
    policy === "worker"
      ? "cloud worker provider required"
      : policy === "storage"
        ? "storage provider required"
        : policy === "decision"
          ? "decision model selected"
          : undefined,
    isProviderCompatStartupPolicy(policy) &&
      isBundledProviderCompatPlugin({
        origin: plugin.origin,
        providers: plugin.contributions?.providers,
        contracts: plugin.contributions?.contracts,
      }),
  );
  if (!activationState.enabled) {
    return false;
  }
  if (policy === "harness" || policy === "implicit-external" || policy === "decision") {
    return true;
  }
  if (policy === "hook") {
    return (
      activationState.explicitlyEnabled ||
      hasExplicitHookPolicyConfig(activationSource.plugins.entries[plugin.pluginId])
    );
  }
  return bundled || activationState.explicitlyEnabled;
}

function manifestOwnsConfiguredContract(
  manifest: PluginManifestRecord | undefined,
  contractKey: StartupContractKey,
  configuredProviderIds: ReadonlySet<string>,
): boolean {
  return (
    configuredProviderIds.size > 0 &&
    (manifest?.contracts?.[contractKey] ?? []).some((providerId) => {
      const normalized = normalizeOptionalLowercaseString(providerId);
      return normalized ? configuredProviderIds.has(normalized) : false;
    })
  );
}

function manifestOwnsConfiguredContractGroup(
  manifest: PluginManifestRecord | undefined,
  configuredProviderIds: ConfiguredGenerationProviderIds | ConfiguredVoiceProviderIds,
): boolean {
  return Object.entries(configuredProviderIds).some(([contractKey, providerIds]) =>
    manifestOwnsConfiguredContract(manifest, contractKey as StartupContractKey, providerIds),
  );
}

/** Evaluates manifest-owned startup surfaces in their original precedence order. */
export function canStartGatewayStartupPlugin(params: GatewayStartupActivationParams): boolean {
  const { manifest, plugin, activationSource, config } = params;
  return (
    (manifestOwnsConfiguredContract(
      manifest,
      "decisionProviders",
      params.configuredDecisionProviderIds,
    ) &&
      passesPluginStartupPolicy(params, "decision")) ||
    (plugin.startup.agentHarnesses.some((runtime) =>
      params.requiredAgentHarnessRuntimes.has(runtime),
    ) &&
      passesPluginStartupPolicy(params, "harness")) ||
    (hasConfiguredActivationPath({ manifest, config: activationSource.rootConfig ?? config }) &&
      passesPluginStartupPolicy(params, "root")) ||
    (manifestOwnsWorkerProvider(manifest, params.configuredWorkerProviderIds) &&
      passesPluginStartupPolicy(params, "worker")) ||
    (manifestOwnsStorageProvider(manifest, params.configuredStorageProviderIds) &&
      passesPluginStartupPolicy(params, "storage")) ||
    (manifestOwnsConfiguredContract(
      manifest,
      "speechProviders",
      params.configuredSpeechProviderIds,
    ) &&
      passesPluginStartupPolicy(params, "speech")) ||
    (manifestOwnsConfiguredContract(
      manifest,
      "webSearchProviders",
      params.configuredWebSearchProviderIds,
    ) &&
      passesPluginStartupPolicy(params, "implicit-external")) ||
    (manifestOwnsConfiguredModelProvider({
      manifest,
      configuredModelProviderIds: params.configuredModelProviderIds,
    }) &&
      passesPluginStartupPolicy(params, "provider")) ||
    (manifestOwnsConfiguredContractGroup(manifest, params.configuredGenerationProviderIds) &&
      passesPluginStartupPolicy(params, "provider")) ||
    (manifestOwnsConfiguredContractGroup(manifest, params.configuredVoiceProviderIds) &&
      passesPluginStartupPolicy(params, "provider")) ||
    (manifestOwnsConfiguredContract(
      manifest,
      "embeddingProviders",
      params.configuredMemoryEmbeddingProviderIds,
    ) &&
      passesPluginStartupPolicy(params, "implicit-external")) ||
    ((manifest?.activation?.onCapabilities?.includes("hook") === true ||
      hasExplicitHookPolicyConfig(activationSource.plugins.entries[plugin.pluginId])) &&
      passesPluginStartupPolicy(params, "hook")) ||
    // Tool factories execute synchronously while an agent surface is built. Load enabled owners
    // at the Gateway lifecycle boundary so a first concurrent turn cannot block control traffic.
    ((manifest?.contracts?.tools?.length ?? 0) > 0 && passesPluginStartupPolicy(params, "tool")) ||
    ((manifest?.contracts?.trustedToolPolicies?.length ?? 0) > 0 &&
      passesPluginStartupPolicy(params, "provider"))
  );
}
