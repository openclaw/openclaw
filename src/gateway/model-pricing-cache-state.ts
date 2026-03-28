import { normalizeModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { LruMap } from "../shared/lru-map.js";

export type CachedModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const MAX_PRICING_ENTRIES = 500;

let cachedPricing: Map<string, CachedModelPricing> = new LruMap<string, CachedModelPricing>(MAX_PRICING_ENTRIES);
let cachedAt = 0;

const WRAPPER_PROVIDERS = new Set([
  "cloudflare-ai-gateway",
  "kilocode",
  "openrouter",
  "vercel-ai-gateway",
]);

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

function shouldNormalizeCachedPricingLookup(provider: string): boolean {
  const normalized = normalizeProviderId(provider);
  return (
    normalized === "anthropic" ||
    normalized === "openrouter" ||
    normalized === "xai" ||
    WRAPPER_PROVIDERS.has(normalized)
  );
}

export function replaceGatewayModelPricingCache(
  nextPricing: Map<string, CachedModelPricing>,
  nextCachedAt = Date.now(),
): void {
  const lru = new LruMap<string, CachedModelPricing>(MAX_PRICING_ENTRIES);
  for (const [key, value] of nextPricing) {
    lru.set(key, value);
  }
  cachedPricing = lru;
  cachedAt = nextCachedAt;
}

export function clearGatewayModelPricingCacheState(): void {
  cachedPricing = new LruMap<string, CachedModelPricing>(MAX_PRICING_ENTRIES);
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
  const direct = key ? cachedPricing.get(key) : undefined;
  if (direct) {
    return direct;
  }
  if (!shouldNormalizeCachedPricingLookup(provider)) {
    return undefined;
  }
  const normalized = normalizeModelRef(provider, model);
  const normalizedKey = modelPricingCacheKey(normalized.provider, normalized.model);
  return normalizedKey ? cachedPricing.get(normalizedKey) : undefined;
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
        const normalized = normalizeModelRef(entry.provider, entry.model, {
          allowPluginNormalization: false,
        });
        const key = modelPricingCacheKey(normalized.provider, normalized.model);
        return key ? ([[key, entry.pricing]] as const) : [];
      }),
    ),
  );
}
