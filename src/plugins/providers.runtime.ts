import { withActivatedPluginIds } from "./activation-context.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
  type PluginLoadOptions,
} from "./loader.js";
import { hasExplicitPluginIdScope } from "./plugin-scope.js";
import {
  resolveActivatableProviderOwnerPluginIds,
  resolveDiscoverableProviderOwnerPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForModelRefs,
  withBundledProviderVitestCompat,
} from "./providers.js";
import { getActivePluginRegistry, getActivePluginRegistryWorkspaceDir } from "./runtime.js";
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
    hasExplicitPluginIdScope(params.onlyPluginIds) ||
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
  return {
    env,
    workspaceDir,
    requestedPluginIds,
    explicitOwnerPluginIds,
    rawConfig: params.config,
  };
}

function resolveSetupProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProviders>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const providerPluginIds = resolveDiscoveredProviderPluginIds({
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const explicitOwnerPluginIds = resolveDiscoverableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: params.config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const setupPluginIds = mergeExplicitOwnerPluginIds(providerPluginIds, explicitOwnerPluginIds);
  if (setupPluginIds.length === 0) {
    return undefined;
  }
  const setupConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: setupPluginIds,
  });
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: setupConfig,
      activationSourceConfig: setupConfig,
      autoEnabledReasons: {},
      workspaceDir: base.workspaceDir,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
    },
    {
      onlyPluginIds: setupPluginIds,
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
  const explicitOwnerPluginIds = resolveActivatableProviderOwnerPluginIds({
    pluginIds: base.explicitOwnerPluginIds,
    config: base.rawConfig,
    workspaceDir: base.workspaceDir,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
  });
  const runtimeRequestedPluginIds =
    base.requestedPluginIds !== undefined
      ? dedupeSortedPluginIds([...(params.onlyPluginIds ?? []), ...explicitOwnerPluginIds])
      : undefined;
  const requestConfig = withActivatedPluginIds({
    config: base.rawConfig,
    pluginIds: explicitOwnerPluginIds,
  });
  const activation = resolveBundledPluginCompatibleActivationInputs({
    rawConfig: requestConfig,
    env: base.env,
    workspaceDir: base.workspaceDir,
    onlyPluginIds: runtimeRequestedPluginIds,
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
      onlyPluginIds: runtimeRequestedPluginIds,
    }),
    explicitOwnerPluginIds,
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

/**
 * Check whether the active gateway plugin registry already satisfies a runtime
 * provider request. When the gateway loaded provider plugins at startup (or in
 * a prior lazy load that was activated), subsequent calls from agent sessions
 * and cron jobs with different workspace dirs should reuse those providers
 * instead of triggering an expensive full plugin load for each unique context.
 *
 * Returns the matching provider list when the active registry covers the
 * requested provider plugin IDs, or `undefined` when a fresh load is needed.
 */
function tryResolveProvidersFromActiveRegistry(
  providerPluginIds: readonly string[],
): ProviderPlugin[] | undefined {
  if (providerPluginIds.length === 0) {
    return undefined;
  }
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry || activeRegistry.providers.length === 0) {
    return undefined;
  }
  const activeProviderPluginIds = new Set(activeRegistry.providers.map((entry) => entry.pluginId));
  const allCovered = providerPluginIds.every((id) => activeProviderPluginIds.has(id));
  if (!allCovered) {
    return undefined;
  }
  // Filter to only the requested provider plugin IDs so the caller sees the
  // same set it would get from a dedicated scoped load.
  const requestedSet = new Set(providerPluginIds);
  return activeRegistry.providers
    .filter((entry) => requestedSet.has(entry.pluginId))
    .map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }));
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

  // Fast path: if the active gateway registry already loaded the needed
  // provider plugins, reuse them instead of triggering a separate load.
  // Provider plugins are workspace-independent — their registration output
  // does not vary with the caller's workspace dir or agent context.
  const activeProviders = tryResolveProvidersFromActiveRegistry(
    loadState.loadOptions.onlyPluginIds ?? [],
  );
  if (activeProviders) {
    return activeProviders;
  }

  const registry = resolveRuntimePluginRegistry(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
