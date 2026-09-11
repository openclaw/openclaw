/** Static manifest rows for setup flows before a runtime owner exists. */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginContributionOwners } from "../../plugins/plugin-registry-contributions.js";
import {
  getPluginRecord,
  isPluginEnabled,
  type PluginRegistrySnapshot,
} from "../../plugins/plugin-registry-snapshot.js";

function planManifestCatalogRowsForPluginIds(params: {
  cfg: OpenClawConfig;
  registry: PluginManifestRegistry;
  pluginIds?: readonly string[];
  providerFilter?: string;
}): readonly NormalizedModelCatalogRow[] {
  if (params.pluginIds && params.pluginIds.length === 0) {
    return [];
  }
  const pluginIdSet = params.pluginIds ? new Set(params.pluginIds) : undefined;
  const registry = pluginIdSet
    ? {
        ...params.registry,
        plugins: params.registry.plugins.filter((plugin) => pluginIdSet.has(plugin.id)),
      }
    : params.registry;
  return planEffectiveModelCatalogRows({
    registry,
    config: params.cfg,
    ...(params.providerFilter ? { providerFilter: params.providerFilter } : {}),
    selection: "static",
  }).rows;
}

function resolveConventionModelCatalogPluginIds(params: {
  cfg: OpenClawConfig;
  index: PluginRegistrySnapshot;
  providerFilter: string;
}): readonly string[] {
  const record = getPluginRecord({
    index: params.index,
    pluginId: params.providerFilter,
  });
  if (
    !record ||
    !isPluginEnabled({
      index: params.index,
      pluginId: record.pluginId,
      config: params.cfg,
    })
  ) {
    return [];
  }
  return [record.pluginId];
}

function resolveDeclaredModelCatalogPluginIds(params: {
  cfg: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  providerFilter: string;
}): readonly string[] {
  return resolvePluginContributionOwners({
    lookUpTable: params.snapshot,
    config: params.cfg,
    contribution: "modelCatalogProviders",
    matches: params.providerFilter,
  });
}

/** Loads authoritative static rows without importing provider runtimes. */
export function loadStaticManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter?: string;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): readonly NormalizedModelCatalogRow[] {
  const providerFilter = params.providerFilter
    ? normalizeModelCatalogProviderId(params.providerFilter)
    : undefined;
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    });
  if (!providerFilter) {
    return planManifestCatalogRowsForPluginIds({
      cfg: params.cfg,
      registry: snapshot.manifestRegistry,
    });
  }
  const conventionRows = planManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    registry: snapshot.manifestRegistry,
    pluginIds: resolveConventionModelCatalogPluginIds({
      cfg: params.cfg,
      index: snapshot.index,
      providerFilter,
    }),
    providerFilter,
  });
  if (conventionRows.length > 0) {
    return conventionRows;
  }
  return planManifestCatalogRowsForPluginIds({
    cfg: params.cfg,
    registry: snapshot.manifestRegistry,
    pluginIds: resolveDeclaredModelCatalogPluginIds({
      cfg: params.cfg,
      snapshot,
      providerFilter,
    }),
    providerFilter,
  });
}
