import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

export type ModelListSourcePlanKind =
  | "registry"
  | "manifest"
  | "provider-index"
  | "provider-runtime-static"
  | "provider-runtime-scoped";

/** Source-selection result that tells model list which catalogs/runtime paths to query. */
export type ModelListSourcePlan = {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows: readonly NormalizedModelCatalogRow[];
  requiresInitialRegistry: boolean;
  skipRuntimeModelSuppression: boolean;
  fallbackToRegistryWhenEmpty: boolean;
};

type ProviderIndexCatalogModule = typeof import("./list.provider-index-catalog.js");

const providerIndexCatalogLoader = createLazyImportLoader<ProviderIndexCatalogModule>(
  () => import("./list.provider-index-catalog.js"),
);

function createSourcePlan(params: {
  kind: ModelListSourcePlanKind;
  manifestCatalogRows?: readonly NormalizedModelCatalogRow[];
  providerIndexCatalogRows?: readonly NormalizedModelCatalogRow[];
  requiresInitialRegistry?: boolean;
  skipRuntimeModelSuppression?: boolean;
  fallbackToRegistryWhenEmpty?: boolean;
}): ModelListSourcePlan {
  return {
    kind: params.kind,
    manifestCatalogRows: params.manifestCatalogRows ?? [],
    providerIndexCatalogRows: params.providerIndexCatalogRows ?? [],
    requiresInitialRegistry: params.requiresInitialRegistry ?? false,
    skipRuntimeModelSuppression: params.skipRuntimeModelSuppression ?? false,
    fallbackToRegistryWhenEmpty: params.fallbackToRegistryWhenEmpty ?? false,
  };
}

/** Source plan that preserves the legacy registry-first listing path. */
export function createRegistryModelListSourcePlan(): ModelListSourcePlan {
  return createSourcePlan({
    kind: "registry",
    requiresInitialRegistry: true,
  });
}

/** Chooses the cheapest model-list sources for the current flags and provider filter. */
export async function planAllModelListSources(params: {
  all?: boolean;
  enableCascade?: boolean;
  providerFilter?: string;
  cfg: OpenClawConfig;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelListSourcePlan> {
  const enableCascade = params.enableCascade ?? params.all;
  if (!enableCascade) {
    return createRegistryModelListSourcePlan();
  }

  const { loadStaticManifestCatalogRowsForList, loadSupplementalManifestCatalogRowsForList } =
    await import("./list.manifest-catalog.js");
  if (!params.providerFilter) {
    const { loadProviderIndexCatalogRowsForList } = await providerIndexCatalogLoader.load();
    // Unfiltered cascades keep registry rows first, then add supplemental
    // manifest/provider-index rows so broad lists retain runtime availability.
    return createSourcePlan({
      kind: "registry",
      manifestCatalogRows: loadSupplementalManifestCatalogRowsForList({
        cfg: params.cfg,
        metadataSnapshot: params.metadataSnapshot,
      }),
      providerIndexCatalogRows: loadProviderIndexCatalogRowsForList({
        cfg: params.cfg,
      }),
      requiresInitialRegistry: true,
    });
  }

  const staticManifestCatalogRows = loadStaticManifestCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });
  const manifestCatalogRows =
    staticManifestCatalogRows.length === 0
      ? loadSupplementalManifestCatalogRowsForList({
          cfg: params.cfg,
          providerFilter: params.providerFilter,
          metadataSnapshot: params.metadataSnapshot,
        })
      : staticManifestCatalogRows;

  if (manifestCatalogRows.length > 0) {
    if (staticManifestCatalogRows.length === 0) {
      // Supplemental manifest rows still need registry context for availability
      // and suppression because they are not an authoritative provider catalog.
      return createSourcePlan({
        kind: "registry",
        manifestCatalogRows,
        requiresInitialRegistry: true,
      });
    }
    return createSourcePlan({
      kind: "manifest",
      manifestCatalogRows,
      skipRuntimeModelSuppression: true,
    });
  }

  const { loadProviderIndexCatalogRowsForList } = await providerIndexCatalogLoader.load();
  const providerIndexCatalogRows = loadProviderIndexCatalogRowsForList({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
  });
  if (providerIndexCatalogRows.length > 0) {
    return createSourcePlan({
      kind: "provider-index",
      providerIndexCatalogRows,
      skipRuntimeModelSuppression: true,
    });
  }

  const { hasProviderStaticCatalogForFilter } = await import("./list.provider-catalog.js");
  const hasProviderStaticCatalog = await hasProviderStaticCatalogForFilter({
    cfg: params.cfg,
    providerFilter: params.providerFilter,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (hasProviderStaticCatalog) {
    // Static provider catalogs can answer the filtered list directly; keep a
    // registry fallback for plugins that report no rows at runtime.
    return createSourcePlan({
      kind: "provider-runtime-static",
      skipRuntimeModelSuppression: true,
      fallbackToRegistryWhenEmpty: true,
    });
  }

  return createSourcePlan({
    kind: "provider-runtime-scoped",
    fallbackToRegistryWhenEmpty: true,
  });
}
