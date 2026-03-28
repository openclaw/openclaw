import { normalizeProviderId } from "../agents/provider-id.js";

export type CachedModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

let cachedPricing = new Map<string, CachedModelPricing>();
let cachedAt = 0;

function modelPricingCacheKey(provider: string, model: string): string {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  if (!providerId || !modelId) {
    return "";
  }
  return modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`)
    ? modelId
    : `${providerId}/${modelId}`;
}

export function replaceGatewayModelPricingCache(
  nextPricing: Map<string, CachedModelPricing>,
  nextCachedAt = Date.now(),
): void {
  cachedPricing = nextPricing;
  cachedAt = nextCachedAt;
}

export function clearGatewayModelPricingCacheState(): void {
  cachedPricing = new Map();
  cachedAt = 0;
}

export function getCachedGatewayModelPricing(params: {
  provider?: string;
  model?: string;
}): CachedModelPricing | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const key = modelPricingCacheKey(provider, model);
  return key ? cachedPricing.get(key) : undefined;
}

export function getGatewayModelPricingCacheMeta(): {
  cachedAt: number;
  ttlMs: number;
  size: number;
} {
  return {
    cachedAt,
    ttlMs: 0,
    size: cachedPricing.size,
  };
}

export function __resetGatewayModelPricingCacheForTest(): void {
  clearGatewayModelPricingCacheState();
}

export function __setGatewayModelPricingForTest(
  entries: Array<{ provider: string; model: string; pricing: CachedModelPricing }>,
): void {
  replaceGatewayModelPricingCache(
    new Map(
      entries.flatMap((entry) => {
        const key = modelPricingCacheKey(entry.provider, entry.model);
        return key ? ([[key, entry.pricing]] as const) : [];
      }),
    ),
  );
}
