export type CachedPricingTier = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** [startTokens, endTokens) — half-open interval on the input token axis. */
    range: [number, number];
};
export type CachedModelPricing = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Optional tiered pricing tiers sourced from LiteLLM or local config. */
    tieredPricing?: CachedPricingTier[];
};
export declare function replaceGatewayModelPricingCache(nextPricing: Map<string, CachedModelPricing>, nextCachedAt?: number): void;
export declare function clearGatewayModelPricingCacheState(): void;
export declare function getCachedGatewayModelPricing(params: {
    provider?: string;
    model?: string;
}): CachedModelPricing | undefined;
export declare function getGatewayModelPricingCacheMeta(): {
    cachedAt: number;
    ttlMs: number;
    size: number;
};
export declare function __resetGatewayModelPricingCacheForTest(): void;
export declare function __setGatewayModelPricingForTest(entries: Array<{
    provider: string;
    model: string;
    pricing: CachedModelPricing;
}>): void;
