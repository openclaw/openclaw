import type { ModelCatalog, ModelCatalogProvider, ModelCatalogSource, NormalizedModelCatalogRow } from "./types.js";
export declare function normalizeModelCatalog(value: unknown, params: {
    ownedProviders: ReadonlySet<string>;
}): ModelCatalog | undefined;
export declare function normalizeModelCatalogProviderRows(params: {
    provider: string;
    providerCatalog: ModelCatalogProvider;
    source: ModelCatalogSource;
}): NormalizedModelCatalogRow[];
export declare function normalizeModelCatalogRows(params: {
    providers: Record<string, ModelCatalogProvider>;
    source: ModelCatalogSource;
}): NormalizedModelCatalogRow[];
