import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestConfigContracts } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
export {
  collectPluginConfigContractMatches,
  type PluginConfigContractMatch,
} from "./config-contract-matches.js";

export type PluginConfigContractMetadata = {
  origin: PluginOrigin;
  configContracts: PluginManifestConfigContracts;
};

type PluginConfigContractRecordRead =
  | {
      ok: true;
      id: string;
      origin: PluginOrigin;
      configContracts?: PluginManifestConfigContracts;
    }
  | { ok: false };

function readPluginConfigContractRecord(
  plugin: PluginManifestRegistry["plugins"][number],
): PluginConfigContractRecordRead {
  try {
    return {
      ok: true,
      id: plugin.id,
      origin: plugin.origin,
      configContracts: plugin.configContracts,
    };
  } catch {
    return { ok: false };
  }
}

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
      const record = readPluginConfigContractRecord(plugin);
      if (!record.ok) {
        continue;
      }
      bundledContractFallbacks.set(record.id, record.configContracts);
    }
    if (!bundledContractFallbacks.has(pluginId)) {
      bundledContractFallbacks.set(pluginId, undefined);
    }
    return bundledContractFallbacks.get(pluginId);
  };

  const resolvedPluginOrigins = new Map<string, PluginOrigin>();
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  for (const plugin of registry.plugins) {
    const record = readPluginConfigContractRecord(plugin);
    if (!record.ok || !pluginIds.includes(record.id)) {
      continue;
    }
    resolvedPluginOrigins.set(record.id, record.origin);
    if (!record.configContracts) {
      continue;
    }
    matches.set(record.id, {
      origin: record.origin,
      configContracts: record.configContracts,
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
        if (bundledConfigContracts) {
          matches.set(pluginId, {
            origin: fallbackBundledPluginIds.has(pluginId) ? "bundled" : existing.origin,
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
      if (!bundledConfigContracts) {
        continue;
      }
      matches.set(pluginId, {
        origin: "bundled",
        configContracts: bundledConfigContracts,
      });
    }
  }

  return matches;
}
