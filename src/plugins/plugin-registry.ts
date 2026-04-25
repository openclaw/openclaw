import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import {
  readPersistedInstalledPluginIndexSync,
  type InstalledPluginIndexStoreInspection,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store.js";
import {
  getInstalledPluginRecord,
  isInstalledPluginEnabled,
  listInstalledPluginContributionIds,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  resolveInstalledPluginContributionOwners,
  type InstalledPluginContributionKey,
  type InstalledPluginIndex,
  type InstalledPluginIndexRecord,
  type LoadInstalledPluginIndexParams,
  type RefreshInstalledPluginIndexParams,
} from "./installed-plugin-index.js";

export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode =
  | "persisted-registry-disabled"
  | "persisted-registry-missing";

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code: PluginRegistrySnapshotDiagnosticCode;
  message: string;
};

export type PluginRegistrySnapshotResult = {
  snapshot: PluginRegistrySnapshot;
  source: PluginRegistrySnapshotSource;
  diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};

export const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";

export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams &
  InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
  };

export type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
  includeDisabled?: boolean;
};

export type GetPluginRecordParams = LoadPluginRegistryParams & {
  pluginId: string;
};

export type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
  contribution: InstalledPluginContributionKey;
  matches: string | ((contributionId: string) => boolean);
};

export type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
  contribution: InstalledPluginContributionKey;
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

function normalizeContributionId(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAlias(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAliasKey(value: string): string {
  return normalizePluginRegistryAlias(value).toLowerCase();
}

export function createPluginRegistryIdNormalizer(
  index: PluginRegistrySnapshot,
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of [...index.plugins].toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  )) {
    const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginRegistryAliasKey(pluginId), pluginId);
    for (const alias of [
      ...plugin.contributions.providers,
      ...plugin.contributions.channels,
      ...plugin.contributions.setupProviders,
      ...plugin.contributions.cliBackends,
      ...plugin.contributions.modelCatalogProviders,
    ]) {
      const normalizedAlias = normalizePluginRegistryAlias(alias);
      const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = normalizePluginRegistryAlias(pluginId);
    return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
  };
}

export function normalizePluginsConfigWithRegistry(
  config: OpenClawConfig["plugins"] | undefined,
  index: PluginRegistrySnapshot,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolver(config, createPluginRegistryIdNormalizer(index));
}

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

export function loadPluginRegistrySnapshotWithMetadata(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshotResult {
  if (params.index) {
    return {
      snapshot: params.index,
      source: "provided",
      diagnostics: [],
    };
  }

  const env = params.env ?? process.env;
  const diagnostics: PluginRegistrySnapshotDiagnostic[] = [];
  const disabledByCaller = params.preferPersisted === false;
  const disabledByEnv = hasEnvFlag(env, DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV);
  const persistedReadsEnabled = !disabledByCaller && !disabledByEnv;
  if (persistedReadsEnabled) {
    const persisted = readPersistedInstalledPluginIndexSync(params);
    if (persisted) {
      return {
        snapshot: persisted,
        source: "persisted",
        diagnostics,
      };
    }
    diagnostics.push({
      level: "info",
      code: "persisted-registry-missing",
      message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
    });
  } else {
    diagnostics.push({
      level: "warn",
      code: "persisted-registry-disabled",
      message: disabledByEnv
        ? `${DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV} is set; using legacy derived plugin index.`
        : "Persisted plugin registry reads are disabled by the caller; using derived plugin index.",
    });
  }

  return {
    snapshot: loadInstalledPluginIndex(params),
    source: "derived",
    diagnostics,
  };
}

function resolveSnapshot(params: LoadPluginRegistryParams = {}): PluginRegistrySnapshot {
  return loadPluginRegistrySnapshotWithMetadata(params).snapshot;
}

export function loadPluginRegistrySnapshot(
  params: LoadPluginRegistryParams = {},
): PluginRegistrySnapshot {
  return resolveSnapshot(params);
}

export function listPluginRecords(
  params: LoadPluginRegistryParams = {},
): readonly PluginRegistryRecord[] {
  return listInstalledPluginRecords(resolveSnapshot(params));
}

export function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined {
  return getInstalledPluginRecord(resolveSnapshot(params), params.pluginId);
}

export function isPluginEnabled(params: GetPluginRecordParams): boolean {
  return isInstalledPluginEnabled(resolveSnapshot(params), params.pluginId, params.config);
}

export function listPluginContributionIds(
  params: ListPluginContributionIdsParams,
): readonly string[] {
  return listInstalledPluginContributionIds(resolveSnapshot(params), params.contribution, {
    includeDisabled: params.includeDisabled,
    config: params.config,
  });
}

export function resolvePluginContributionOwners(
  params: ResolvePluginContributionOwnersParams,
): readonly string[] {
  return resolveInstalledPluginContributionOwners(
    resolveSnapshot(params),
    params.contribution,
    params.matches,
    {
      includeDisabled: params.includeDisabled,
      config: params.config,
    },
  );
}

export function resolveProviderOwners(params: ResolveProviderOwnersParams): readonly string[] {
  const providerId = normalizeProviderId(params.providerId);
  if (!providerId) {
    return [];
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

export function inspectPluginRegistry(
  params: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions = {},
): Promise<PluginRegistryInspection> {
  return import("./installed-plugin-index-store.js").then((store) =>
    store.inspectPersistedInstalledPluginIndex(params),
  );
}

export function refreshPluginRegistry(
  params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions,
): Promise<PluginRegistrySnapshot> {
  return import("./installed-plugin-index-store.js").then((store) =>
    store.refreshPersistedInstalledPluginIndex(params),
  );
}
