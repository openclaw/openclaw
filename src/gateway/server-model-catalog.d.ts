import { type ModelCatalogEntry } from "../agents/model-catalog.js";
import { getRuntimeConfig } from "../config/config.js";
export type GatewayModelChoice = ModelCatalogEntry;
export declare function __resetModelCatalogCacheForTest(): void;
export declare function loadGatewayModelCatalog(params?: {
    getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]>;
