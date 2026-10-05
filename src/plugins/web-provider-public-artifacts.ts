import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { readBundledDiscoveryModeMemoized } from "./bundled-discovery-state.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { normalizePluginId } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import {
  resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
  type BundledExplicitWebProviderParams,
} from "./web-provider-public-artifacts.explicit.js";
import {
  resolveBundledWebProviderResolutionConfig,
  resolveManifestDeclaredWebProviderCandidates,
} from "./web-provider-resolution-shared.js";

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
};

function filterAllowlistedBundledPluginIds(
  config: PluginLoadOptions["config"] | undefined,
  pluginIds: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  // Deprecated shipped compat marker: old allowlist configs used this to keep
  // bundled web provider discovery available while plugin IDs were tightened.
  if (readBundledDiscoveryModeMemoized(env) === "compat") {
    return [...pluginIds];
  }
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return [...pluginIds];
  }
  const allowedPluginIds = new Set(
    normalizeUniqueStringEntries(allow.map((pluginId) => normalizePluginId(pluginId))),
  );
  return pluginIds.filter((pluginId) => allowedPluginIds.has(pluginId));
}

function resolveBundledCandidatePluginIds(
  params: BundledWebProviderPublicArtifactParams & {
    contract: "webSearchProviders" | "webFetchProviders";
    mode: "setup" | "runtime";
  },
) {
  if (params.mode === "setup" && params.onlyPluginIds !== undefined) {
    return {
      pluginIds: filterAllowlistedBundledPluginIds(
        params.config,
        [...new Set(params.onlyPluginIds)],
        params.env,
      ).toSorted((left, right) => left.localeCompare(right)),
      ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
    };
  }
  const resolvedConfig = resolveBundledWebProviderResolutionConfig(params).config;
  const candidates = resolveManifestDeclaredWebProviderCandidates({
    contract: params.contract,
    configKey: params.contract === "webSearchProviders" ? "webSearch" : "webFetch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.mode === "setup" ? "bundled" : undefined,
    manifestRecords: params.manifestRecords,
  });
  return {
    pluginIds: filterAllowlistedBundledPluginIds(
      resolvedConfig,
      candidates.pluginIds ?? [],
      params.env,
    ),
    ...(candidates.manifestRecords ? { manifestRecords: candidates.manifestRecords } : {}),
  };
}

function resolveBundledRuntimeCandidates(
  params: BundledWebProviderPublicArtifactParams & {
    contract: "webSearchProviders" | "webFetchProviders";
    onlyPluginIds: readonly string[];
  },
): BundledExplicitWebProviderParams | null {
  const candidates = resolveBundledCandidatePluginIds({
    ...params,
    mode: "runtime",
  });
  const { pluginIds } = candidates;
  const recordsByPluginId = new Map(
    (candidates.manifestRecords ?? []).map((record) => [record.id, record] as const),
  );
  if (pluginIds.some((pluginId) => recordsByPluginId.get(pluginId)?.origin !== "bundled")) {
    return null;
  }
  const enabledPluginIds = new Set(
    resolveEnabledBundledManifestContractPlugins({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      onlyPluginIds: pluginIds,
      contract: params.contract,
      manifestRecords: candidates.manifestRecords,
    }).map((plugin) => plugin.id),
  );
  return {
    onlyPluginIds: pluginIds.filter((pluginId) => enabledPluginIds.has(pluginId)),
    env: params.env,
    manifestRecords: candidates.manifestRecords,
  };
}

function resolveBundledWebProvidersFromPublicArtifacts<TProvider>(params: {
  loadExplicit: (params: BundledExplicitWebProviderParams) => TProvider[] | null;
  contract: "webSearchProviders" | "webFetchProviders";
  resolution: BundledWebProviderPublicArtifactParams;
}): TProvider[] | null {
  const candidates = resolveBundledCandidatePluginIds({
    ...params.resolution,
    contract: params.contract,
    mode: "setup",
  });
  if (candidates.pluginIds.length === 0) {
    return [];
  }
  const manifestRecords = candidates.manifestRecords ?? params.resolution.manifestRecords;
  const explicit = {
    onlyPluginIds: candidates.pluginIds,
    env: params.resolution.env,
    manifestRecords,
  };
  // Prepared owners retain their selected roots; only an unprepared named miss needs discovery.
  const explicitProviders = params.loadExplicit(explicit);
  if (explicitProviders || manifestRecords) {
    return explicitProviders;
  }
  return params.loadExplicit({
    ...explicit,
    manifestRecords: loadManifestMetadataSnapshot({
      config: params.resolution.config,
      workspaceDir: params.resolution.workspaceDir,
      env: params.resolution.env,
    }).plugins,
  });
}

export function resolveBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  return resolveBundledWebProvidersFromPublicArtifacts({
    contract: "webSearchProviders",
    resolution: params,
    loadExplicit: resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
  });
}

export function resolveBundledWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebFetchProviderEntry[] | null {
  return resolveBundledWebProvidersFromPublicArtifacts({
    contract: "webFetchProviders",
    resolution: params,
    loadExplicit: resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  });
}

export function resolveEnabledBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams & { onlyPluginIds: readonly string[] },
): PluginWebSearchProviderEntry[] | null {
  const candidates = resolveBundledRuntimeCandidates({
    ...params,
    contract: "webSearchProviders",
  });
  return candidates
    ? resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(candidates)
    : null;
}

export function resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams & {
    onlyPluginIds: readonly string[];
  },
): PluginWebFetchProviderEntry[] | null {
  const candidates = resolveBundledRuntimeCandidates({
    ...params,
    contract: "webFetchProviders",
  });
  return candidates
    ? resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts(candidates)
    : null;
}
