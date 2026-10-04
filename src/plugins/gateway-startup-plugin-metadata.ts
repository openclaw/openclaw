// Builds deterministic metadata scopes for startup planning.
import { getConfiguredDecisionProviderIds } from "../agents/decision-model-setting.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfigWithResolverCore } from "./config-normalization-shared.js";
import { addRequiredAgentHarnessPluginIds } from "./gateway-startup-plugin-activation.js";
import {
  addConfiguredActivationPathPluginIds,
  addConfiguredSlotPluginIds,
  addPluginConfigEntryIds,
  collectConfiguredProviderIds,
  collectConfiguredStartupChannelIds,
  collectValidationConfiguredRefs,
  collectValidationConfiguredShorthandModelIds,
  readStartupBundledDiscoveryMode,
  resolveAuthorizedGatewayStartupDreamingPluginIds,
  resolveMemorySlotStartupPluginId,
} from "./gateway-startup-plugin-config.js";
import { sortUniquePluginIds } from "./gateway-startup-plugin-contracts.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginMetadataSnapshotPluginIdScope } from "./plugin-metadata-snapshot.types.js";
import { collectConfiguredStorageProviderIds } from "./storage-provider-manifest.js";
import { collectConfiguredWorkerProviderIds } from "./worker-provider-config.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

export function resolveGatewayStartupMetadataPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: InstalledPluginIndex;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const sameConfig = activationSourceConfig === params.config;
  const pluginsConfig = normalizePluginsConfigWithResolverCore(
    params.config.plugins,
    lookup.normalizePluginId,
  );
  const activationSourcePlugins = sameConfig
    ? pluginsConfig
    : normalizePluginsConfigWithResolverCore(
        activationSourceConfig.plugins,
        lookup.normalizePluginId,
      );
  if (!pluginsConfig.enabled || !activationSourcePlugins.enabled) {
    return [];
  }
  if (
    readStartupBundledDiscoveryMode(params.config, params.env) === "compat" ||
    readStartupBundledDiscoveryMode(activationSourceConfig, params.env) === "compat"
  ) {
    return undefined;
  }
  if (pluginsConfig.allow.length === 0 && activationSourcePlugins.allow.length === 0) {
    return undefined;
  }

  // Facts belong to this invocation; raw activation and effective configs can differ.
  const configs = sameConfig ? [params.config] : [params.config, activationSourceConfig];
  const pluginConfigs = sameConfig ? [pluginsConfig] : [pluginsConfig, activationSourcePlugins];
  const scope = new Set(
    pluginConfigs.flatMap((plugins) => plugins.allow.map(lookup.normalizePluginId)),
  );
  for (const plugins of pluginConfigs) {
    addPluginConfigEntryIds(scope, plugins, lookup.normalizePluginId);
  }

  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId: lookup.normalizePluginId,
  });
  addConfiguredSlotPluginIds(scope, {
    activationSourceConfig,
    activationSourcePlugins,
    lookup,
  });
  for (const pluginId of resolveAuthorizedGatewayStartupDreamingPluginIds({
    config: params.config,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    activationSourcePlugins,
    selectedMemoryPluginId: memorySlotStartupPluginId,
    index: params.index,
    platform: params.platform,
  })) {
    scope.add(pluginId);
  }
  if (!lookup.hasCompleteConfigPathActivationMetadata()) {
    return undefined;
  }
  addConfiguredActivationPathPluginIds(scope, {
    activationSourceConfig,
    index: params.index,
  });

  const configuredChannelIds = collectConfiguredStartupChannelIds({
    configs,
    env: params.env,
    ambientEnvTriggers: params.ambientEnvTriggers,
    includePersistedAuthState: false,
  });
  if (!lookup.hasDirectChannelOwners(configuredChannelIds)) {
    return undefined;
  }
  lookup.addDirectChannelOwners(scope, configuredChannelIds);

  const providerIds = configs.flatMap(collectConfiguredProviderIds);
  const validationRefs = configs.map(collectValidationConfiguredRefs);
  const configuredProviderIds = sortUniquePluginIds([
    ...providerIds,
    ...validationRefs.flatMap((refs) => refs.providerIds),
  ]);
  if (!lookup.canResolveDirectProviderIds(configuredProviderIds, scope)) {
    return undefined;
  }
  lookup.addDirectProviderOwners(scope, configuredProviderIds);

  const decisionProviderIds = configs.flatMap(getConfiguredDecisionProviderIds);
  if (!lookup.hasProviderContributionOwners(decisionProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, decisionProviderIds);

  const workerProviderIds = normalizeWorkerProviderIds([
    ...configs.flatMap(collectConfiguredWorkerProviderIds),
    ...(params.workerProviderIds ?? []),
  ]);
  if (!lookup.hasProviderContributionOwners(workerProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, workerProviderIds);
  const storageProviderIds = configs.flatMap(collectConfiguredStorageProviderIds);
  if (!lookup.hasProviderContributionOwners(storageProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, storageProviderIds);

  const configuredShorthandModelIds = sortUniquePluginIds(
    validationRefs.flatMap((refs) =>
      collectValidationConfiguredShorthandModelIds(refs.shorthandModelRefs),
    ),
  );
  if (!lookup.hasShorthandModelOwners(configuredShorthandModelIds)) {
    return undefined;
  }
  lookup.addShorthandModelOwners(scope, configuredShorthandModelIds);

  addRequiredAgentHarnessPluginIds(scope, {
    activationSourceConfig,
    config: params.config,
    index: params.index,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    env: params.env,
    platform: params.platform,
  });

  const deniedPluginIds = new Set(pluginConfigs.flatMap((plugins) => plugins.deny));
  for (const pluginId of deniedPluginIds) {
    scope.delete(lookup.normalizePluginId(pluginId));
  }
  for (const plugins of pluginConfigs) {
    for (const [pluginId, entry] of Object.entries(plugins.entries)) {
      if (entry?.enabled === false) {
        scope.delete(lookup.normalizePluginId(pluginId));
      }
    }
  }
  if (!lookup.hasInstalledPluginIds(scope)) {
    return undefined;
  }
  return sortUniquePluginIds(scope);
}

export function createGatewayStartupMetadataPluginIdScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): PluginMetadataSnapshotPluginIdScope {
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  return {
    resolve: ({ index }) =>
      resolveGatewayStartupMetadataPluginIds({
        config: params.config,
        activationSourceConfig: params.activationSourceConfig,
        env: params.env,
        index,
        ...(workerProviderIds.length > 0 ? { workerProviderIds } : {}),
        platform: params.platform,
        ambientEnvTriggers: params.ambientEnvTriggers,
      }),
  };
}
