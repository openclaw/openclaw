/** Resolves plugin config contract metadata for scanners and secret/config policy checks. */
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findBundledPluginMetadataById } from "./bundled-plugin-metadata.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestConfigContracts, PluginManifestContracts } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
export { collectPluginConfigContractMatches } from "./config-contract-matches.js";

type PluginConfigContractMetadata = {
  /** Runtime origin that supplied the contract metadata. */
  origin: PluginOrigin;
  /** Capability contracts that determine runtime ownership of config subtrees. */
  contracts?: PluginManifestContracts;
  /** Manifest-declared config contract paths used by secret/security/config scanners. */
  configContracts: PluginManifestConfigContracts;
};

/** Resolve config contract metadata for plugin ids through the runtime registry and bundled fallback. */
export function resolvePluginConfigContractsById(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToBundledMetadata?: boolean;
  fallbackToBundledMetadataForResolvedBundled?: boolean;
  fallbackBundledPluginIds?: readonly string[];
  pluginIds: readonly string[];
  discovery?: PluginDiscoveryResult;
}): ReadonlyMap<string, PluginConfigContractMetadata> {
  const matches = new Map<string, PluginConfigContractMetadata>();
  const pluginIds = normalizeSortedUniqueStringEntries(params.pluginIds);
  if (pluginIds.length === 0) {
    return matches;
  }
  const fallbackBundledPluginIds = new Set(
    normalizeSortedUniqueStringEntries(params.fallbackBundledPluginIds),
  );
  const bundledContractFallbacks = new Map<string, PluginManifestConfigContracts | undefined>();
  const bundledCapabilityContractFallbacks = new Map<string, PluginManifestContracts | undefined>();
  const findBundledConfigContracts = (
    pluginId: string,
  ): PluginManifestConfigContracts | undefined => {
    if (bundledContractFallbacks.has(pluginId)) {
      return bundledContractFallbacks.get(pluginId);
    }
    const discovery =
      params.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
    const registry = loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      candidates: discovery.candidates.filter((candidate) => candidate.origin === "bundled"),
      diagnostics: discovery.diagnostics,
    });
    for (const plugin of registry.plugins) {
      bundledContractFallbacks.set(plugin.id, plugin.configContracts);
      bundledCapabilityContractFallbacks.set(plugin.id, plugin.contracts);
    }
    if (bundledContractFallbacks.get(pluginId) === undefined) {
      const bundledMetadata = findBundledPluginMetadataById(pluginId, {
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
      });
      if (bundledMetadata?.manifest.configContracts) {
        bundledContractFallbacks.set(pluginId, bundledMetadata.manifest.configContracts);
      }
      if (bundledMetadata?.manifest.contracts) {
        bundledCapabilityContractFallbacks.set(pluginId, bundledMetadata.manifest.contracts);
      }
    }
    if (!bundledContractFallbacks.has(pluginId)) {
      bundledContractFallbacks.set(pluginId, undefined);
    }
    return bundledContractFallbacks.get(pluginId);
  };
  const findBundledCapabilityContracts = (
    pluginId: string,
  ): PluginManifestContracts | undefined => {
    if (!bundledCapabilityContractFallbacks.has(pluginId)) {
      findBundledConfigContracts(pluginId);
    }
    return bundledCapabilityContractFallbacks.get(pluginId);
  };

  const resolvedPluginOrigins = new Map<string, PluginOrigin>();
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  for (const plugin of registry.plugins) {
    if (!pluginIds.includes(plugin.id)) {
      continue;
    }
    resolvedPluginOrigins.set(plugin.id, plugin.origin);
    if (!plugin.configContracts) {
      continue;
    }
    matches.set(plugin.id, {
      origin: plugin.origin,
      ...(plugin.contracts ? { contracts: plugin.contracts } : {}),
      configContracts: plugin.configContracts,
    });
  }

  if (params.fallbackToBundledMetadata ?? true) {
    for (const pluginId of pluginIds) {
      const existing = matches.get(pluginId);
      const shouldHydrateBundledMatch =
        existing &&
        ((params.fallbackToBundledMetadataForResolvedBundled && existing.origin === "bundled") ||
          fallbackBundledPluginIds.has(pluginId));
      if (shouldHydrateBundledMatch) {
        const bundledConfigContracts = findBundledConfigContracts(pluginId);
        const bundledCapabilityContracts = findBundledCapabilityContracts(pluginId);
        if (bundledConfigContracts) {
          // Bundled metadata can carry richer contract declarations than installed registry entries;
          // installed declarations still win except for bundled secret input coverage.
          matches.set(pluginId, {
            origin: fallbackBundledPluginIds.has(pluginId) ? "bundled" : existing.origin,
            ...(existing.contracts || bundledCapabilityContracts
              ? { contracts: existing.contracts ?? bundledCapabilityContracts }
              : {}),
            configContracts: {
              ...bundledConfigContracts,
              ...existing.configContracts,
              ...(bundledConfigContracts.secretInputs
                ? { secretInputs: bundledConfigContracts.secretInputs }
                : {}),
            },
          });
        }
        continue;
      }
      if (matches.has(pluginId)) {
        continue;
      }
      const resolvedOrigin = resolvedPluginOrigins.get(pluginId);
      if (
        resolvedOrigin &&
        !(params.fallbackToBundledMetadataForResolvedBundled && resolvedOrigin === "bundled") &&
        !fallbackBundledPluginIds.has(pluginId)
      ) {
        continue;
      }
      const bundledConfigContracts = findBundledConfigContracts(pluginId);
      const bundledCapabilityContracts = findBundledCapabilityContracts(pluginId);
      if (!bundledConfigContracts) {
        continue;
      }
      matches.set(pluginId, {
        origin: "bundled",
        ...(bundledCapabilityContracts ? { contracts: bundledCapabilityContracts } : {}),
        configContracts: bundledConfigContracts,
      });
    }
  }

  return matches;
}
