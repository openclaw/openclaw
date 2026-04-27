import type { ModelCatalog, NormalizedModelCatalogRow } from "./types.js";
export type ManifestModelCatalogPlugin = {
    id: string;
    modelCatalog?: Pick<ModelCatalog, "providers">;
};
export type ManifestModelCatalogRegistry = {
    plugins: readonly ManifestModelCatalogPlugin[];
};
export type ManifestModelCatalogPlanEntry = {
    pluginId: string;
    provider: string;
    rows: readonly NormalizedModelCatalogRow[];
};
export type ManifestModelCatalogConflict = {
    mergeKey: string;
    ref: string;
    provider: string;
    modelId: string;
    firstPluginId: string;
    secondPluginId: string;
};
export type ManifestModelCatalogPlan = {
    rows: readonly NormalizedModelCatalogRow[];
    entries: readonly ManifestModelCatalogPlanEntry[];
    conflicts: readonly ManifestModelCatalogConflict[];
};
export declare function planManifestModelCatalogRows(params: {
    registry: ManifestModelCatalogRegistry;
    providerFilter?: string;
}): ManifestModelCatalogPlan;
