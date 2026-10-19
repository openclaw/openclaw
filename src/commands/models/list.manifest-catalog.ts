/** Static manifest rows for setup flows before a runtime owner exists. */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginContributionOwners } from "../../plugins/plugin-registry-contributions.js";

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
  const rowsForPluginIds = (
    pluginIds?: readonly string[],
  ): readonly NormalizedModelCatalogRow[] => {
    if (pluginIds?.length === 0) {
      return [];
    }
    const pluginIdSet = pluginIds ? new Set(pluginIds) : undefined;
    const registry = snapshot.manifestRegistry;
    return planEffectiveModelCatalogRows({
      registry: pluginIdSet
        ? { ...registry, plugins: registry.plugins.filter((plugin) => pluginIdSet.has(plugin.id)) }
        : registry,
      config: params.cfg,
      ...(providerFilter ? { providerFilter } : {}),
      selection: "static",
    }).rows;
  };
  if (!providerFilter) {
    return rowsForPluginIds();
  }
  const conventionRows = rowsForPluginIds(
    isInstalledPluginEnabled(snapshot.index, providerFilter, params.cfg, params.env)
      ? [providerFilter]
      : [],
  );
  if (conventionRows.length > 0) {
    return conventionRows;
  }
  return rowsForPluginIds(
    resolvePluginContributionOwners({
      lookUpTable: snapshot,
      config: params.cfg,
      env: params.env,
      contribution: "modelCatalogProviders",
      matches: providerFilter,
    }),
  );
}
