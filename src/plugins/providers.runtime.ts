import { normalizeProviderId } from "../agents/provider-id.js";
import { withActivatedPluginIds } from "./activation-context.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
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
import { getActivePluginRegistry, getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import { resolvePluginSetupRegistry } from "./setup-registry.js";
import type { ProviderPlugin } from "./types.js";

function matchesProviderRef(provider: ProviderPlugin, providerRef: string): boolean {
  const normalized = normalizeProviderId(providerRef);
  if (!normalized) {
    return false;
  }
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveOwningPluginIdsForProviderRefsFromEntries(params: {
  providerRefs?: readonly string[];
  entries: readonly { pluginId: string; provider: ProviderPlugin }[];
}): Map<string, string[]> {
  const ownership = new Map<string, string[]>();
  if (!params.providerRefs?.length || params.entries.length === 0) {
    return ownership;
  }
  for (const providerRef of params.providerRefs) {
    const pluginIds = [
      ...new Set(
        params.entries
          .filter((entry) => matchesProviderRef(entry.provider, providerRef))
          .map((entry) => entry.pluginId),
      ),
    ].toSorted((left, right) => left.localeCompare(right));
    if (pluginIds.length > 0) {
      ownership.set(providerRef, pluginIds);
    }
  }
  return ownership;
}

function resolvePreferredProviderOwnedPluginIds(params: {
  providerRefs: readonly string[];
  manifestOwnedProviderPluginIdsByRef: ReadonlyMap<string, readonly string[]>;
  setupRegistryOwnedProviderPluginIdsByRef: ReadonlyMap<string, readonly string[]>;
  activeRuntimeOwnedProviderPluginIdsByRef: ReadonlyMap<string, readonly string[]>;
}): string[] {
  if (params.providerRefs.length === 0) {
    return [];
  }
  return [
    ...new Set(
      params.providerRefs.flatMap((providerRef) => {
        const manifestPluginIds = params.manifestOwnedProviderPluginIdsByRef.get(providerRef) ?? [];
        if (manifestPluginIds.length > 0) {
          return manifestPluginIds;
        }
        const setupRegistryPluginIds =
          params.setupRegistryOwnedProviderPluginIdsByRef.get(providerRef) ?? [];
        if (setupRegistryPluginIds.length > 0) {
          return setupRegistryPluginIds;
        }
        return params.activeRuntimeOwnedProviderPluginIdsByRef.get(providerRef) ?? [];
      }),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolveActiveRuntimeOwningPluginIdsForProviders(params: {
  providerRefs?: readonly string[];
  workspaceDir?: string;
}): Map<string, string[]> {
  if (!params.providerRefs?.length) {
    return new Map();
  }
  const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  if (params.workspaceDir && activeWorkspaceDir && params.workspaceDir !== activeWorkspaceDir) {
    return new Map();
  }
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return new Map();
  }
  return resolveOwningPluginIdsForProviderRefsFromEntries({
    providerRefs: params.providerRefs,
    entries: activeRegistry.providers,
  });
}

function resolveSetupRegistryOwningPluginIdsForProviders(params: {
  providerRefs?: readonly string[];
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): Map<string, string[]> {
  if (!params.providerRefs?.length) {
    return new Map();
  }
  const candidatePluginIds = resolveDiscoveredProviderPluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (candidatePluginIds.length === 0) {
    return new Map();
  }
  return resolveOwningPluginIdsForProviderRefsFromEntries({
    providerRefs: params.providerRefs,
    entries: resolvePluginSetupRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: candidatePluginIds,
    }).providers,
  });
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
  const providerRefs = params.providerRefs ?? [];
  const manifestOwnedProviderPluginIdsByRef = new Map(
    providerRefs.map((providerRef) => [
      providerRef,
      resolveOwningPluginIdsForProvider({
        provider: providerRef,
        config: params.config,
        workspaceDir,
        env,
      }) ?? [],
    ]),
  );
  const activeRuntimeOwnedProviderPluginIdsByRef = resolveActiveRuntimeOwningPluginIdsForProviders({
    providerRefs,
    workspaceDir,
  });
  const setupFallbackProviderRefs = providerRefs.filter(
    (providerRef) => (manifestOwnedProviderPluginIdsByRef.get(providerRef)?.length ?? 0) === 0,
  );
  const setupRegistryOwnedProviderPluginIdsByRef = resolveSetupRegistryOwningPluginIdsForProviders({
    providerRefs: setupFallbackProviderRefs,
    config: params.config,
    workspaceDir,
    env,
  });
  const providerOwnedPluginIds = resolvePreferredProviderOwnedPluginIds({
    providerRefs,
    manifestOwnedProviderPluginIdsByRef,
    setupRegistryOwnedProviderPluginIdsByRef,
    activeRuntimeOwnedProviderPluginIdsByRef,
  });
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
  return {
    env,
    workspaceDir,
    requestedPluginIds,
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
    return undefined;
  }
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      config: withActivatedPluginIds({
        config: base.runtimeConfig,
        pluginIds: providerPluginIds,
      }),
      activationSourceConfig: base.runtimeConfig,
      autoEnabledReasons: {},
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
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    workspaceDir: base.workspaceDir,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
  });
  if (providerPluginIds.length === 0) {
    return undefined;
  }
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
  if (!loadState) {
    return [];
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
