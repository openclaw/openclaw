import { withActivatedPluginIds } from "./activation-context.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
  type PluginLoadOptions,
} from "./loader.js";
import {
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForModelRefs,
  withBundledProviderVitestCompat,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolveExplicitProviderOwnerPluginIds(params: {
  providerRefs: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return dedupeSortedPluginIds(
    params.providerRefs.flatMap((provider) => {
      const plannedPluginIds = resolveManifestActivationPluginIds({
        trigger: {
          kind: "provider",
          provider,
        },
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
      if (plannedPluginIds.length > 0) {
        return plannedPluginIds;
      }
      // Keep legacy provider/CLI-backend ownership working until every owner is
      // expressible through activation descriptors.
      return (
        resolveOwningPluginIdsForProvider({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
        }) ?? []
      );
    }),
  );
}

function mergeExplicitOwnerPluginIds(
  providerPluginIds: readonly string[],
  explicitOwnerPluginIds: readonly string[],
): string[] {
  if (explicitOwnerPluginIds.length === 0) {
    return [...providerPluginIds];
  }
  return dedupeSortedPluginIds([...providerPluginIds, ...explicitOwnerPluginIds]);
}

function resolvePluginProviderLoadBase(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const providerOwnedPluginIds = params.providerRefs?.length
    ? resolveExplicitProviderOwnerPluginIds({
        providerRefs: params.providerRefs,
        config: params.config,
        workspaceDir,
        env,
      })
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
  const explicitOwnerPluginIds = dedupeSortedPluginIds([
    ...providerOwnedPluginIds,
    ...modelOwnedPluginIds,
  ]);
  const runtimeConfig = withActivatedPluginIds({
    config: params.config,
    pluginIds: explicitOwnerPluginIds,
  });
  return {
    env,
    workspaceDir,
    requestedPluginIds,
    explicitOwnerPluginIds,
    runtimeConfig,
  };
}

function resolveSetupProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProviders>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const providerPluginIds = resolveDiscoveredProviderPluginIds({
    config: base.runtimeConfig,
    workspaceDir: base.workspaceDir,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  if (providerPluginIds.length === 0) {
    if (base.explicitOwnerPluginIds.length === 0) {
      return undefined;
    }
  }
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: withActivatedPluginIds({
        config: base.runtimeConfig,
        pluginIds: mergeExplicitOwnerPluginIds(providerPluginIds, base.explicitOwnerPluginIds),
      }),
      activationSourceConfig: base.runtimeConfig,
      autoEnabledReasons: {},
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: mergeExplicitOwnerPluginIds(providerPluginIds, base.explicitOwnerPluginIds),
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

function resolveRuntimeProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProviders>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: base.runtimeConfig,
    env: base.env,
    workspaceDir: base.workspaceDir,
    onlyPluginIds: base.requestedPluginIds,
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
        env: base.env,
      })
    : activation.config;
  const providerPluginIds = mergeExplicitOwnerPluginIds(
    resolveEnabledProviderPluginIds({
      config,
      workspaceDir: base.workspaceDir,
      env: base.env,
      onlyPluginIds: base.requestedPluginIds,
    }),
    base.explicitOwnerPluginIds,
  );
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config,
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
      cache: params.cache ?? false,
      activate: params.activate ?? false,
    },
  );
  return { loadOptions };
}

export function isPluginProvidersLoadInFlight(
  params: Parameters<typeof resolvePluginProviders>[0],
): boolean {
  const base = resolvePluginProviderLoadBase(params);
  const loadState =
    params.mode === "setup"
      ? resolveSetupProviderPluginLoadState(params, base)
      : resolveRuntimeProviderPluginLoadState(params, base);
  if (!loadState) {
    return false;
  }
  return isPluginRegistryLoadInFlight(loadState.loadOptions);
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
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderPlugin[] {
  const base = resolvePluginProviderLoadBase(params);
  if (params.mode === "setup") {
    const loadState = resolveSetupProviderPluginLoadState(params, base);
    if (!loadState) {
      return [];
    }
    const registry = loadOpenClawPlugins(loadState.loadOptions);
    return registry.providers.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }));
  }
  const loadState = resolveRuntimeProviderPluginLoadState(params, base);
  const registry = resolveRuntimePluginRegistry(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
