import { normalizeModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
let cachedPricing = new Map();
let cachedAt = 0;
const WRAPPER_PROVIDERS = new Set([
    "cloudflare-ai-gateway",
    "kilocode",
    "openrouter",
    "vercel-ai-gateway",
]);
function modelPricingCacheKey(provider, model) {
    const providerId = normalizeProviderId(provider);
    const modelId = model.trim();
    if (!providerId || !modelId) {
        return "";
    }
    return normalizeLowercaseStringOrEmpty(modelId).startsWith(`${normalizeLowercaseStringOrEmpty(providerId)}/`)
        ? modelId
        : `${providerId}/${modelId}`;
}
function shouldNormalizeCachedPricingLookup(provider) {
    const normalized = normalizeProviderId(provider);
    return (normalized === "anthropic" ||
        normalized === "openrouter" ||
        normalized === "xai" ||
        WRAPPER_PROVIDERS.has(normalized));
}
export function replaceGatewayModelPricingCache(nextPricing, nextCachedAt = Date.now()) {
    cachedPricing = nextPricing;
    cachedAt = nextCachedAt;
}
export function clearGatewayModelPricingCacheState() {
    cachedPricing = new Map();
    cachedAt = 0;
}
export function getCachedGatewayModelPricing(params) {
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
export function getGatewayModelPricingCacheMeta() {
    return {
        cachedAt,
        ttlMs: 0,
        size: cachedPricing.size,
    };
}
export function __resetGatewayModelPricingCacheForTest() {
    clearGatewayModelPricingCacheState();
}
export function __setGatewayModelPricingForTest(entries) {
    replaceGatewayModelPricingCache(new Map(entries.flatMap((entry) => {
        const normalized = normalizeModelRef(entry.provider, entry.model, {
            allowPluginNormalization: false,
        });
        const key = modelPricingCacheKey(normalized.provider, normalized.model);
        return key ? [[key, entry.pricing]] : [];
    })));
}
