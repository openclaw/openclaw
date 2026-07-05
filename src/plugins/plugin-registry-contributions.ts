/** Loads manifest and installed-index contributions used to build plugin registry snapshots. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import { normalizePluginsConfig, resolveEnableState } from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type {
  BundledChannelConfigCollector,
  PluginManifestContractListKey,
  PluginManifestRecord,
  PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  createPluginRegistryIdNormalizer,
  type PluginRegistryIdNormalizerOptions,
} from "./plugin-registry-id-normalizer.js";
import {
  loadPluginRegistrySnapshot,
  type LoadPluginRegistryParams,
  type PluginRegistrySnapshot,
} from "./plugin-registry-snapshot.js";
export {
  createPluginRegistryIdNormalizer,
  type PluginRegistryIdNormalizerOptions,
} from "./plugin-registry-id-normalizer.js";

export type PluginLookUpTable = Pick<
  PluginMetadataSnapshot,
  "index" | "manifestRegistry" | "plugins" | "normalizePluginId" | "owners"
>;

export type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
  lookUpTable?: PluginLookUpTable;
};

export type LoadPluginRegistryManifestParams = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
  pluginIds?: readonly string[];
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
};

export type PluginRegistryContributionKey =
  | "providers"
  | "channels"
  | "channelConfigs"
  | "setupProviders"
  | "cliBackends"
  | "modelCatalogProviders"
  | "commandAliases"
  | "contracts";

export type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
  matches: string | ((contributionId: string) => boolean);
};

export type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
  contribution: PluginRegistryContributionKey;
};

export type ResolveProviderOwnersParams = PluginRegistryContributionOptions & {
  providerId: string;
};

export type ResolveChannelOwnersParams = PluginRegistryContributionOptions & {
  channelId: string;
};

export type ResolveCliBackendOwnersParams = PluginRegistryContributionOptions & {
  cliBackendId: string;
};

export type ResolveSetupProviderOwnersParams = PluginRegistryContributionOptions & {
  setupProviderId: string;
};

export type ResolveManifestContractPluginIdsParams = LoadPluginRegistryParams & {
  contract: PluginManifestContractListKey;
  origin?: PluginOrigin;
  onlyPluginIds?: readonly string[];
};

export type ResolveManifestContractOwnerPluginIdParams = LoadPluginRegistryParams & {
  contract: PluginManifestContractListKey;
  value: string | undefined;
  origin?: PluginOrigin;
};

export type ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams =
  LoadPluginRegistryParams & {
    contract: PluginManifestContractListKey;
    path: string | undefined;
    origin?: PluginOrigin;
  };

function normalizeContributionId(value: string): string {
  return value.trim();
}

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return value ? Object.keys(value) : [];
}

function collectContractKeys(plugin: PluginManifestRecord): readonly string[] {
  const contracts = plugin.contracts;
  if (!contracts) {
    return [];
  }
  return Object.entries(contracts).flatMap(([key, value]) =>
    Array.isArray(value) && value.length > 0 ? [key] : [],
  );
}

function listManifestContractValues(
  plugin: PluginManifestRecord,
  contract: PluginManifestContractListKey,
): readonly string[] {
  return plugin.contracts?.[contract] ?? [];
}

function loadManifestContractRegistry(
  params: LoadPluginRegistryParams & {
    onlyPluginIds?: readonly string[];
  },
): PluginManifestRegistry {
  return loadPluginManifestRegistryForPluginRegistry({
    ...params,
    pluginIds: params.onlyPluginIds,
    includeDisabled: true,
  });
}

function listManifestContributionIds(
  plugin: PluginManifestRecord,
  contribution: PluginRegistryContributionKey,
): readonly string[] {
  switch (contribution) {
    case "providers":
      return plugin.providers;
    case "channels":
      return plugin.channels;
    case "channelConfigs":
      return collectObjectKeys(plugin.channelConfigs);
    case "setupProviders":
      return plugin.setup?.providers?.map((provider) => provider.id) ?? [];
    case "cliBackends":
      return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])];
    case "modelCatalogProviders":
      return [
        ...collectObjectKeys(plugin.modelCatalog?.providers),
        ...collectObjectKeys(plugin.modelCatalog?.aliases),
      ];
    case "commandAliases":
      return plugin.commandAliases?.map((alias) => alias.name) ?? [];
    case "contracts":
      return collectContractKeys(plugin);
  }
  return [];
}

function resolveContributionPluginIds(params: {
  index: PluginRegistrySnapshot;
  includeDisabled?: boolean;
  config?: OpenClawConfig;
}): readonly string[] {
  if (params.includeDisabled) {
    return params.index.plugins.map((plugin) => plugin.pluginId);
  }
  return params.index.plugins
    .filter((plugin) => isInstalledPluginEnabled(params.index, plugin.pluginId, params.config))
    .map((plugin) => plugin.pluginId);
}

function resolveContributionScopePluginIds(params: {
  index: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  includeDisabled?: boolean;
  config?: OpenClawConfig;
}): readonly string[] {
  const pluginIds = new Set(
    resolveContributionPluginIds({
      index: params.index,
      includeDisabled: params.includeDisabled,
      config: params.config,
    }),
  );
  if (!params.manifestRegistry) {
    return [...pluginIds];
  }
  const indexedPluginIds = new Set(params.index.plugins.map((plugin) => plugin.pluginId));
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  for (const plugin of params.manifestRegistry.plugins) {
    if (indexedPluginIds.has(plugin.id)) {
      continue;
    }
    if (
      params.includeDisabled ||
      resolveEnableState(plugin.id, plugin.origin, normalizedConfig).enabled
    ) {
      pluginIds.add(plugin.id);
    }
  }
  return [...pluginIds];
}

function filterManifestRegistryForContributionScope(params: {
  manifestRegistry: PluginManifestRegistry;
  index: PluginRegistrySnapshot;
  includeDisabled?: boolean;
  config?: OpenClawConfig;
}): PluginManifestRegistry {
  const pluginIds = new Set(
    resolveContributionScopePluginIds({
      index: params.index,
      manifestRegistry: params.manifestRegistry,
      includeDisabled: params.includeDisabled,
      config: params.config,
    }),
  );
  return {
    plugins: params.manifestRegistry.plugins.filter((plugin) => pluginIds.has(plugin.id)),
    diagnostics: params.manifestRegistry.diagnostics.filter(
      (diagnostic) => !diagnostic.pluginId || pluginIds.has(diagnostic.pluginId),
    ),
  };
}

function loadContributionManifestRegistry(
  params: LoadPluginRegistryParams & {
    index: PluginRegistrySnapshot;
    includeDisabled?: boolean;
  },
): PluginManifestRegistry {
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index: params.index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  return filterManifestRegistryForContributionScope({
    manifestRegistry,
    index: params.index,
    includeDisabled: params.includeDisabled,
    config: params.config,
  });
}

function listContributionManifestPlugins(
  params: PluginRegistryContributionOptions & {
    index: PluginRegistrySnapshot;
  },
): readonly PluginManifestRecord[] {
  const lookUpTable = params.lookUpTable;
  const plugins = lookUpTable?.plugins;
  if (plugins) {
    const enabledPluginIds = new Set(
      resolveContributionScopePluginIds({
        index: params.index,
        manifestRegistry: lookUpTable.manifestRegistry,
        includeDisabled: params.includeDisabled,
        config: params.config,
      }),
    );
    return plugins.filter((plugin) => enabledPluginIds.has(plugin.id));
  }
  return loadContributionManifestRegistry({
    ...params,
    index: params.index,
  }).plugins;
}

function resolveContributionOwnerMap(
  table: PluginLookUpTable,
  contribution: PluginRegistryContributionKey,
): ReadonlyMap<string, readonly string[]> | undefined {
  switch (contribution) {
    case "channels":
      return table.owners.channels;
    case "channelConfigs":
      return table.owners.channelConfigs;
    case "providers":
      return table.owners.providers;
    case "modelCatalogProviders":
      return table.owners.modelCatalogProviders;
    case "cliBackends":
      return table.owners.cliBackends;
    case "setupProviders":
      return table.owners.setupProviders;
    case "commandAliases":
      return table.owners.commandAliases;
    case "contracts":
      return table.owners.contracts;
  }
  return undefined;
}

function filterContributionOwnerIds(params: {
  owners: readonly string[];
  index: PluginRegistrySnapshot;
  manifestRegistry?: PluginManifestRegistry;
  includeDisabled?: boolean;
  config?: OpenClawConfig;
}): readonly string[] {
  const enabledPluginIds = new Set(
    resolveContributionScopePluginIds({
      index: params.index,
      manifestRegistry: params.manifestRegistry,
      includeDisabled: params.includeDisabled,
      config: params.config,
    }),
  );
  return normalizeSortedUniqueStringEntries(
    params.owners.filter((owner) => enabledPluginIds.has(owner)),
  );
}

function canReuseCurrentManifestRegistry(params: LoadPluginRegistryManifestParams): boolean {
  return (
    params.bundledChannelConfigCollector === undefined &&
    params.index === undefined &&
    params.preferPersisted !== false &&
    params.stateDir === undefined &&
    params.filePath === undefined &&
    params.pluginIndexFilePath === undefined &&
    params.installRecords === undefined &&
    params.candidates === undefined &&
    params.diagnostics === undefined
  );
}

function loadCurrentManifestRegistryForPluginRegistry(
  params: LoadPluginRegistryManifestParams,
): PluginManifestRegistry | undefined {
  if (!canReuseCurrentManifestRegistry(params)) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
  });
  if (!current || current.registryDiagnostics.length > 0) {
    return undefined;
  }
  const pluginIdSet = params.pluginIds === undefined ? undefined : new Set(params.pluginIds);
  const enabledPluginIds = new Set(
    resolveContributionScopePluginIds({
      index: current.index,
      manifestRegistry: current.manifestRegistry,
      includeDisabled: params.includeDisabled,
      config: params.config,
    }),
  );
  return {
    plugins: current.manifestRegistry.plugins.filter(
      (plugin) =>
        (!pluginIdSet || pluginIdSet.has(plugin.id)) &&
        (params.includeDisabled || enabledPluginIds.has(plugin.id)),
    ),
    diagnostics: pluginIdSet
      ? current.manifestRegistry.diagnostics.filter(
          (diagnostic) => !diagnostic.pluginId || pluginIdSet.has(diagnostic.pluginId),
        )
      : current.manifestRegistry.diagnostics,
  };
}

export function loadPluginManifestRegistryForPluginRegistry(
  params: LoadPluginRegistryManifestParams = {},
): PluginManifestRegistry {
  const current = loadCurrentManifestRegistryForPluginRegistry(params);
  if (current) {
    return current;
  }
  const index = loadPluginRegistrySnapshot(params);
  return loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds: params.pluginIds,
    includeDisabled: params.includeDisabled,
    ...(params.bundledChannelConfigCollector
      ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
      : {}),
  });
}

export function normalizePluginsConfigWithRegistry(
  config: OpenClawConfig["plugins"] | undefined,
  index: PluginRegistrySnapshot,
  options: PluginRegistryIdNormalizerOptions = {},
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolver(
    config,
    createPluginRegistryIdNormalizer(index, options),
  );
}

export function listPluginContributionIds(
  params: ListPluginContributionIdsParams,
): readonly string[] {
  const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
  const plugins = listContributionManifestPlugins({ ...params, index });
  return normalizeSortedUniqueStringEntries(
    plugins.flatMap((plugin) => listManifestContributionIds(plugin, params.contribution)),
  );
}

export function resolvePluginContributionOwners(
  params: ResolvePluginContributionOwnersParams,
): readonly string[] {
  const index = params.lookUpTable?.index ?? loadPluginRegistrySnapshot(params);
  if (params.lookUpTable && typeof params.matches === "string") {
    const ownerMap = resolveContributionOwnerMap(params.lookUpTable, params.contribution);
    const owners = ownerMap?.get(params.matches);
    if (owners) {
      return filterContributionOwnerIds({
        owners,
        index,
        manifestRegistry: params.lookUpTable.manifestRegistry,
        includeDisabled: params.includeDisabled,
        config: params.config,
      });
    }
    return [];
  }
  const matcher =
    typeof params.matches === "string"
      ? (contributionId: string) => contributionId === params.matches
      : params.matches;
  const plugins = listContributionManifestPlugins({ ...params, index });
  return normalizeSortedUniqueStringEntries(
    plugins.flatMap((plugin) =>
      listManifestContributionIds(plugin, params.contribution).some(matcher) ? [plugin.id] : [],
    ),
  );
}

export function resolveProviderOwners(params: ResolveProviderOwnersParams): readonly string[] {
  const providerId = normalizeProviderId(params.providerId);
  if (!providerId) {
    return [];
  }
  if (params.lookUpTable) {
    const index = params.lookUpTable.index;
    const owners: string[] = [];
    for (const [contributionId, ownerIds] of params.lookUpTable.owners.providers.entries()) {
      if (normalizeProviderId(contributionId) === providerId) {
        owners.push(...ownerIds);
      }
    }
    return filterContributionOwnerIds({
      owners,
      index,
      manifestRegistry: params.lookUpTable.manifestRegistry,
      includeDisabled: params.includeDisabled,
      config: params.config,
    });
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "providers",
    matches: (contributionId) => normalizeProviderId(contributionId) === providerId,
  });
}

export function resolveChannelOwners(params: ResolveChannelOwnersParams): readonly string[] {
  const channelId = normalizeContributionId(params.channelId);
  if (!channelId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "channels",
    matches: channelId,
  });
}

export function resolveCliBackendOwners(params: ResolveCliBackendOwnersParams): readonly string[] {
  const cliBackendId = normalizeContributionId(params.cliBackendId);
  if (!cliBackendId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "cliBackends",
    matches: cliBackendId,
  });
}

export function resolveSetupProviderOwners(
  params: ResolveSetupProviderOwnersParams,
): readonly string[] {
  const setupProviderId = normalizeContributionId(params.setupProviderId);
  if (!setupProviderId) {
    return [];
  }
  return resolvePluginContributionOwners({
    ...params,
    contribution: "setupProviders",
    matches: setupProviderId,
  });
}

export function resolveManifestContractPluginIds(
  params: ResolveManifestContractPluginIdsParams,
): string[] {
  return loadManifestContractRegistry(params)
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listManifestContractValues(plugin, params.contract).length > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractPluginIdsByCompatibilityRuntimePath(
  params: ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams,
): string[] {
  const normalizedPath = params.path?.trim();
  if (!normalizedPath) {
    return [];
  }
  return loadManifestContractRegistry(params)
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listManifestContractValues(plugin, params.contract).length > 0 &&
        (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(normalizedPath),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractOwnerPluginId(
  params: ResolveManifestContractOwnerPluginIdParams,
): string | undefined {
  const normalizedValue = normalizeContributionId(params.value ?? "").toLowerCase();
  if (!normalizedValue) {
    return undefined;
  }
  return loadManifestContractRegistry(params).plugins.find(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      listManifestContractValues(plugin, params.contract).some(
        (candidate) => normalizeContributionId(candidate).toLowerCase() === normalizedValue,
      ),
  )?.id;
}
