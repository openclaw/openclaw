import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForModelRefs,
  withBundledProviderVitestCompat,
} from "./providers.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("plugins");

function withRuntimeActivatedPluginIds(params: {
  config?: PluginLoadOptions["config"];
  pluginIds: readonly string[];
}): PluginLoadOptions["config"] {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const allow = new Set(params.config?.plugins?.allow ?? []);
  const entries = {
    ...params.config?.plugins?.entries,
  };
  for (const pluginId of params.pluginIds) {
    const normalized = pluginId.trim();
    if (!normalized) {
      continue;
    }
    allow.add(normalized);
    entries[normalized] = {
      ...entries[normalized],
      enabled: true,
    };
  }
  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      ...(allow.size > 0 ? { allow: [...allow] } : {}),
      entries,
    },
  };
}

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const modelOwnedPluginIds = params.modelRefs?.length
    ? resolveOwningPluginIdsForModelRefs({
        models: params.modelRefs,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env,
      })
    : [];
  const requestedPluginIds =
    params.onlyPluginIds || modelOwnedPluginIds.length > 0
      ? [...new Set([...(params.onlyPluginIds ?? []), ...modelOwnedPluginIds])]
      : undefined;
  const runtimeConfig = withRuntimeActivatedPluginIds({
    config: params.config,
    pluginIds: modelOwnedPluginIds,
  });
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: runtimeConfig,
    env,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: requestedPluginIds,
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledProviderAllowlistCompat,
      enablement: "allowlist",
      vitest: params.bundledProviderVitestCompat,
    },
    resolveCompatPluginIds: resolveBundledProviderCompatPluginIds,
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        pluginIds: activation.compatPluginIds,
        env,
      })
    : activation.config;
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: requestedPluginIds,
  });
  const registry = resolveRuntimePluginRegistry({
    config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: providerPluginIds,
    pluginSdkResolution: params.pluginSdkResolution,
    cache: params.cache ?? false,
    activate: params.activate ?? false,
    logger: createPluginLoaderLogger(log),
  });
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
