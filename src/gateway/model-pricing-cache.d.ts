import { type ModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCachedGatewayModelPricing } from "./model-pricing-cache-state.js";
export { getCachedGatewayModelPricing };
export declare function collectConfiguredModelPricingRefs(config: OpenClawConfig): ModelRef[];
export declare function refreshGatewayModelPricingCache(params: {
    config: OpenClawConfig;
    fetchImpl?: typeof fetch;
}): Promise<void>;
export declare function startGatewayModelPricingRefresh(params: {
    config: OpenClawConfig;
    fetchImpl?: typeof fetch;
}): () => void;
export declare function getGatewayModelPricingCacheMeta(): {
    cachedAt: number;
    ttlMs: number;
    size: number;
};
export declare function __resetGatewayModelPricingCacheForTest(): void;
