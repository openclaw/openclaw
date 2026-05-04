import path from "node:path";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import {
  loadBundledWebFetchProviderEntriesFromDir,
  loadBundledRuntimeWebSearchProviderEntriesFromDir,
  loadBundledWebSearchProviderEntriesFromDir,
  resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidates } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
};

type BundledCandidateResolution = {
  pluginIds: string[];
  manifestRecords?: readonly PluginManifestRecord[];
};

function resolveBundledCandidatePluginIds(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): BundledCandidateResolution {
  if (params.onlyPluginIds && params.onlyPluginIds.length > 0) {
    return {
      pluginIds: [...new Set(params.onlyPluginIds)].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    };
  }
  const resolvedConfig =
    params.contract === "webSearchProviders"
      ? resolveBundledWebSearchResolutionConfig(params).config
      : resolveBundledWebFetchResolutionConfig(params).config;
  const candidates = resolveManifestDeclaredWebProviderCandidates({
    contract: params.contract,
    configKey: params.configKey,
    config: resolvedConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: "bundled",
  });
  return {
    pluginIds: candidates.pluginIds ?? [],
    ...(candidates.manifestRecords ? { manifestRecords: candidates.manifestRecords } : {}),
  };
}

function resolveBundledManifestRecordsByPluginId(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
}) {
  const allowedPluginIds = new Set(params.onlyPluginIds);
  const manifestRecords =
    params.manifestRecords ??
    loadManifestMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).plugins;
  return new Map(
    manifestRecords
      .filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
      .map((record) => [record.id, record] as const),
  );
}

function resolveBundledProvidersFromPublicArtifacts<TProvider>(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  resolveExplicitProviders: (params: { onlyPluginIds: readonly string[] }) => TProvider[] | null;
  loadProvidersFromDir: (params: { dirName: string; pluginId: string }) => TProvider[] | null;
}): TProvider[] | null {
  const pluginIds = resolveBundledCandidatePluginIds({
    contract: params.contract,
    configKey: params.configKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (pluginIds.pluginIds.length === 0) {
    return [];
  }
  const directProviders = params.resolveExplicitProviders({
    onlyPluginIds: pluginIds.pluginIds,
  });
  if (directProviders) {
    return directProviders;
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds.pluginIds,
    manifestRecords: pluginIds.manifestRecords,
  });
  const providers: TProvider[] = [];
  for (const pluginId of pluginIds.pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const loadedProviders = params.loadProvidersFromDir({
      dirName: path.basename(record.rootDir),
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  return resolveBundledProvidersFromPublicArtifacts({
    contract: "webSearchProviders",
    configKey: "webSearch",
    ...params,
    resolveExplicitProviders: resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    loadProvidersFromDir: loadBundledWebSearchProviderEntriesFromDir,
  });
}

export function resolveBundledRuntimeWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  return resolveBundledProvidersFromPublicArtifacts({
    contract: "webSearchProviders",
    configKey: "webSearch",
    ...params,
    resolveExplicitProviders: resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts,
    loadProvidersFromDir: loadBundledRuntimeWebSearchProviderEntriesFromDir,
  });
}

export function resolveBundledWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebFetchProviderEntry[] | null {
  return resolveBundledProvidersFromPublicArtifacts({
    contract: "webFetchProviders",
    configKey: "webFetch",
    ...params,
    resolveExplicitProviders: resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
    loadProvidersFromDir: loadBundledWebFetchProviderEntriesFromDir,
  });
}
