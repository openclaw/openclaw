import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../../model-catalog/index.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";

export function loadStaticManifestCatalogRowsForList(params: {
  cfg: OpenClawConfig;
  providerFilter: string;
  env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[] {
  const registry = loadPluginManifestRegistry({
    config: params.cfg,
    env: params.env,
    cache: true,
  });
  const plan = planManifestModelCatalogRows({
    registry,
    providerFilter: params.providerFilter,
  });
  const staticProviders = new Set(
    plan.entries.filter((entry) => entry.discovery === "static").map((entry) => entry.provider),
  );
  if (staticProviders.size === 0) {
    return [];
  }
  return plan.rows.filter((row) => staticProviders.has(row.provider));
}
