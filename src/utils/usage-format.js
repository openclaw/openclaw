import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { modelKey, normalizeModelRef, normalizeProviderId } from "../agents/model-selection.js";
import { getCachedGatewayModelPricing } from "../gateway/model-pricing-cache.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
let modelsJsonCostCache = null;
export function formatTokenCount(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return "0";
    }
    const safe = Math.max(0, value);
    if (safe >= 1_000_000) {
        return `${(safe / 1_000_000).toFixed(1)}m`;
    }
    if (safe >= 1_000) {
        const precision = safe >= 10_000 ? 0 : 1;
        const formattedThousands = (safe / 1_000).toFixed(precision);
        if (Number(formattedThousands) >= 1_000) {
            return `${(safe / 1_000_000).toFixed(1)}m`;
        }
        return `${formattedThousands}k`;
    }
    return String(Math.round(safe));
}
export function formatUsd(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return undefined;
    }
    if (value >= 1) {
        return `$${value.toFixed(2)}`;
    }
    if (value >= 0.01) {
        return `$${value.toFixed(2)}`;
    }
    return `$${value.toFixed(4)}`;
}
function toResolvedModelKey(params) {
    const provider = normalizeOptionalString(params.provider);
    const model = normalizeOptionalString(params.model);
    if (!provider || !model) {
        return null;
    }
    const normalized = normalizeModelRef(provider, model, {
        allowPluginNormalization: params.allowPluginNormalization,
    });
    return modelKey(normalized.provider, normalized.model);
}
function toDirectModelKey(params) {
    const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
    const model = normalizeOptionalString(params.model);
    if (!provider || !model) {
        return null;
    }
    return modelKey(provider, model);
}
function shouldUseNormalizedCostLookup(params) {
    const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
    const model = normalizeOptionalString(params.model) ?? "";
    if (!provider || !model) {
        return false;
    }
    return provider === "anthropic" || provider === "openrouter" || provider === "vercel-ai-gateway";
}
/**
 * Normalize a raw tieredPricing array from models.json / config.
 * Supports open-ended ranges such as `[128000]` or `[128000, -1]`,
 * which are converted to `[128000, Infinity]`.
 */
function normalizeTieredPricing(raw) {
    if (!raw || raw.length === 0) {
        return undefined;
    }
    const result = [];
    for (const tier of raw) {
        const range = tier.range;
        if (!Array.isArray(range) || range.length < 1) {
            continue;
        }
        const start = typeof range[0] === "number" ? range[0] : Number.NaN;
        if (!Number.isFinite(start)) {
            continue;
        }
        const rawEnd = range.length >= 2 ? range[1] : null;
        const end = typeof rawEnd === "number" && Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : Infinity;
        if (!Number.isFinite(tier.input) ||
            !Number.isFinite(tier.output) ||
            !Number.isFinite(tier.cacheRead) ||
            !Number.isFinite(tier.cacheWrite)) {
            continue;
        }
        result.push({
            input: tier.input,
            output: tier.output,
            cacheRead: tier.cacheRead,
            cacheWrite: tier.cacheWrite,
            range: [start, end],
        });
    }
    return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : undefined;
}
function buildProviderCostIndex(providers, options) {
    const entries = new Map();
    if (!providers) {
        return entries;
    }
    for (const [providerKey, providerConfig] of Object.entries(providers)) {
        const normalizedProvider = normalizeProviderId(providerKey);
        for (const model of providerConfig?.models ?? []) {
            const normalized = normalizeModelRef(normalizedProvider, model.id, {
                allowPluginNormalization: options?.allowPluginNormalization,
            });
            const cost = { ...model.cost };
            const normalizedTiers = normalizeTieredPricing(cost.tieredPricing);
            const costConfig = {
                input: cost.input,
                output: cost.output,
                cacheRead: cost.cacheRead,
                cacheWrite: cost.cacheWrite,
                ...(normalizedTiers ? { tieredPricing: normalizedTiers } : {}),
            };
            entries.set(modelKey(normalized.provider, normalized.model), costConfig);
        }
    }
    return entries;
}
function loadModelsJsonCostIndex(options) {
    const useRawEntries = options?.allowPluginNormalization === false;
    const modelsPath = path.join(resolveOpenClawAgentDir(), "models.json");
    try {
        const stat = fs.statSync(modelsPath);
        if (!modelsJsonCostCache ||
            modelsJsonCostCache.path !== modelsPath ||
            modelsJsonCostCache.mtimeMs !== stat.mtimeMs) {
            const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
            modelsJsonCostCache = {
                path: modelsPath,
                mtimeMs: stat.mtimeMs,
                providers: parsed.providers,
                normalizedEntries: null,
                rawEntries: null,
            };
        }
        if (useRawEntries) {
            modelsJsonCostCache.rawEntries ??= buildProviderCostIndex(modelsJsonCostCache.providers, {
                allowPluginNormalization: false,
            });
            return modelsJsonCostCache.rawEntries;
        }
        modelsJsonCostCache.normalizedEntries ??= buildProviderCostIndex(modelsJsonCostCache.providers);
        return modelsJsonCostCache.normalizedEntries;
    }
    catch {
        const empty = new Map();
        modelsJsonCostCache = {
            path: modelsPath,
            mtimeMs: -1,
            providers: undefined,
            normalizedEntries: empty,
            rawEntries: empty,
        };
        return empty;
    }
}
function findConfiguredProviderCost(params) {
    const key = toResolvedModelKey(params);
    if (!key) {
        return undefined;
    }
    return buildProviderCostIndex(params.config?.models?.providers, {
        allowPluginNormalization: params.allowPluginNormalization,
    }).get(key);
}
export function resolveModelCostConfig(params) {
    const rawKey = toDirectModelKey(params);
    if (!rawKey) {
        return undefined;
    }
    // Favor direct configured keys first so local pricing/status lookups stay
    // synchronous and do not drag plugin/provider discovery into the hot path.
    const rawModelsJsonCost = loadModelsJsonCostIndex({
        allowPluginNormalization: false,
    }).get(rawKey);
    if (rawModelsJsonCost) {
        return rawModelsJsonCost;
    }
    const rawConfiguredCost = findConfiguredProviderCost({
        ...params,
        allowPluginNormalization: false,
    });
    if (rawConfiguredCost) {
        return rawConfiguredCost;
    }
    if (params.allowPluginNormalization === false) {
        return undefined;
    }
    if (shouldUseNormalizedCostLookup(params)) {
        const key = toResolvedModelKey(params);
        if (key && key !== rawKey) {
            const modelsJsonCost = loadModelsJsonCostIndex().get(key);
            if (modelsJsonCost) {
                return modelsJsonCost;
            }
            const configuredCost = findConfiguredProviderCost(params);
            if (configuredCost) {
                return configuredCost;
            }
        }
    }
    return getCachedGatewayModelPricing(params);
}
const toNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
function selectPricingTier(tiers, input) {
    const sortedTiers = tiers.toSorted((a, b) => a.range[0] - b.range[0]);
    if (sortedTiers.length === 0) {
        return undefined;
    }
    if (input <= 0) {
        return sortedTiers[0];
    }
    for (const tier of sortedTiers) {
        const [start, end] = tier.range;
        if (input >= start && input < end) {
            return tier;
        }
    }
    for (let index = sortedTiers.length - 1; index >= 0; index -= 1) {
        const tier = sortedTiers[index];
        if (input >= tier.range[0]) {
            return tier;
        }
    }
    return sortedTiers[0];
}
function computeTieredCost(tiers, input, output, cacheRead, cacheWrite) {
    const tier = selectPricingTier(tiers, input);
    if (!tier) {
        return 0;
    }
    return (input * tier.input +
        output * tier.output +
        cacheRead * tier.cacheRead +
        cacheWrite * tier.cacheWrite);
}
export function estimateUsageCost(params) {
    const usage = params.usage;
    const cost = params.cost;
    if (!usage || !cost) {
        return undefined;
    }
    const input = toNumber(usage.input);
    const output = toNumber(usage.output);
    const cacheRead = toNumber(usage.cacheRead);
    const cacheWrite = toNumber(usage.cacheWrite);
    let total;
    if (cost.tieredPricing && cost.tieredPricing.length > 0) {
        total = computeTieredCost(cost.tieredPricing, input, output, cacheRead, cacheWrite);
    }
    else {
        total =
            input * cost.input +
                output * cost.output +
                cacheRead * cost.cacheRead +
                cacheWrite * cost.cacheWrite;
    }
    if (!Number.isFinite(total)) {
        return undefined;
    }
    return total / 1_000_000;
}
export function __resetUsageFormatCachesForTest() {
    modelsJsonCostCache = null;
}
