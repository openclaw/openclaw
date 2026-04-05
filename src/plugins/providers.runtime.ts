import { createSubsystemLogger } from "../logging/subsystem.js";
import { withActivatedPluginIds } from "./activation-context.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import {
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
  type PluginLoadOptions,
} from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import {
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForModelRefs,
  withBundledProviderVitestCompat,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
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
  for (const pluginId of [...params.pluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
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
      ...(allow.size > 0
        ? { allow: [...allow].toSorted((left, right) => left.localeCompare(right)) }
        : {}),
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
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
  mode?: "runtime" | "setup";
}): ProviderPlugin[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const providerOwnedPluginIds = params.providerRefs?.length
    ? [
        ...new Set(
          params.providerRefs.flatMap(
            (provider) =>
              resolveOwningPluginIdsForProvider({
                provider,
                config: params.config,
                workspaceDir,
                env,
              }) ?? [],
          ),
        ),
      ]
    : [];
  const modelOwnedPluginIds = params.modelRefs?.length
    ? resolveOwningPluginIdsForModelRefs({
        models: params.modelRefs,
        config: params.config,
        workspaceDir,
        env,
      })
    : [];
  const requestedPluginIds =
    params.onlyPluginIds ||
    params.providerRefs?.length ||
    params.modelRefs?.length ||
    providerOwnedPluginIds.length > 0 ||
    modelOwnedPluginIds.length > 0
      ? [
          ...new Set([
            ...(params.onlyPluginIds ?? []),
            ...providerOwnedPluginIds,
            ...modelOwnedPluginIds,
          ]),
        ].toSorted((left, right) => left.localeCompare(right))
      : undefined;
  const runtimeConfig = withActivatedPluginIds({
    config: params.config,
    pluginIds: [...providerOwnedPluginIds, ...modelOwnedPluginIds],
  });
  if (params.mode === "setup") {
    const providerPluginIds = resolveDiscoveredProviderPluginIds({
      config: runtimeConfig,
      workspaceDir,
      env,
      onlyPluginIds: requestedPluginIds,
    });
    if (providerPluginIds.length === 0) {
      return [];
    }
    const registry = loadOpenClawPlugins({
      config: withActivatedPluginIds({
        config: runtimeConfig,
        pluginIds: providerPluginIds,
      }),
      activationSourceConfig: runtimeConfig,
      autoEnabledReasons: {},
      workspaceDir,
      env,
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
      logger: createPluginLoaderLogger(log),
    });
    return registry.providers.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }));
  }
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: runtimeConfig,
    env,
    workspaceDir,
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
    workspaceDir,
    env,
    onlyPluginIds: requestedPluginIds,
  });
  const registry = resolveRuntimePluginRegistry({
    config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
    workspaceDir,
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
