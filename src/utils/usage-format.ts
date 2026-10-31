/**
 * Shared token/cost formatting and pricing lookup helpers for CLI, TUI, gateway, and status output.
 * Keep this module synchronous; request paths call it while rendering usage summaries.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  calculateUsageCost,
  normalizeModelCostConfig,
  normalizeResolvedPricing,
  type ModelCostConfig,
  type RawModelCostConfig,
} from "@openclaw/llm-core";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeBuiltInProviderModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  resolveAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { MODELS_JSON_STATE, type ModelKeyNormalizer } from "../agents/models-config-state.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import { hasRecordedUsageCost, type NormalizedUsage } from "../agents/usage.js";
import { mergeModelCost } from "../config/model-cost.js";
import { resolveStateDir } from "../config/paths.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { UsageCacheStatus } from "../infra/session-cost-usage.types.js";
import {
  modelCatalogPricingFingerprint,
  resolveModelPricing,
  resolveModelPricingContext,
  type PricingContext,
} from "../model-catalog/pricing.js";
export { formatTokenCount } from "./token-format.js";
export type { ModelCostConfig } from "@openclaw/llm-core";

const EMPTY_PROVIDER_COST_INDEX = new Map<string, RawModelCostConfig>();
const MODELS_JSON_COST_CACHE_LIMIT = 128;

const providerCostIndexByNormalizer = new WeakMap<
  ModelKeyNormalizer,
  WeakMap<Record<string, ModelProviderConfig>, Map<string, RawModelCostConfig>>
>();

/** Formats a USD amount for usage summaries, keeping tiny costs visible. */
export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

/** Prefix aggregate totals with their recorded cache-readiness notice. */
export function formatCostUsageCachePrefix(cacheStatus?: UsageCacheStatus): string {
  return cacheStatus && cacheStatus.status !== "fresh"
    ? `Usage totals may be incomplete (${cacheStatus.status}). Run this command again later.\n`
    : "";
}

function normalizeRawModelKey(provider: string, model: string): string {
  const providerId = normalizeProviderId(provider);
  // Built-in aliases remain valid; a provider-shaped prefix alone is model data.
  return buildModelCatalogRef(
    providerId,
    normalizeBuiltInProviderModelId(providerId, model.trim()),
  );
}

function hasModelCostRates(
  cost: Partial<RawModelCostConfig> | undefined,
): cost is Partial<RawModelCostConfig> {
  return (
    cost !== undefined &&
    (cost.input !== undefined ||
      cost.output !== undefined ||
      cost.cacheRead !== undefined ||
      cost.cacheWrite !== undefined ||
      Boolean(cost.tieredPricing?.length))
  );
}

function getProviderCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  normalizeKey: ModelKeyNormalizer = normalizeRawModelKey,
): Map<string, RawModelCostConfig> {
  if (!providers) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  // Captured policy owns normalized keys; provider config identity alone is insufficient.
  let cache = providerCostIndexByNormalizer.get(normalizeKey);
  if (!cache) {
    cache = new WeakMap();
    providerCostIndexByNormalizer.set(normalizeKey, cache);
  }
  let index = cache.get(providers);
  if (!index) {
    // Config publication replaces snapshots; in-place edits refresh on the next publication.
    index = new Map();
    for (const [providerKey, provider] of Object.entries(normalizeProviderMapKeys(providers))) {
      for (const model of provider?.models ?? []) {
        if (model.cost !== null && typeof model.cost === "object") {
          const key = normalizeKey(providerKey, model.id);
          const cost = mergeModelCost(model.cost, index.get(key));
          if (cost) {
            index.set(key, cost);
          }
        }
      }
    }
    cache.set(providers, index);
  }
  return index;
}

function loadModelsJsonCostIndex(
  agentDir: string | undefined,
  normalizeKey: ModelKeyNormalizer = normalizeRawModelKey,
): Map<string, RawModelCostConfig> {
  if (!agentDir) {
    return EMPTY_PROVIDER_COST_INDEX;
  }
  const modelsPath = path.join(agentDir, "models.json");
  try {
    let modelsJsonCostCache = MODELS_JSON_STATE.costCache.get(agentDir);
    if (!modelsJsonCostCache) {
      const parsed = tryReadJsonSync<{
        providers?: Record<string, ModelProviderConfig>;
      }>(modelsPath);
      if (!parsed) {
        return EMPTY_PROVIDER_COST_INDEX;
      }
      modelsJsonCostCache = {
        providers: parsed?.providers,
      };
      pruneMapToMaxSize(MODELS_JSON_STATE.costCache, MODELS_JSON_COST_CACHE_LIMIT - 1);
      MODELS_JSON_STATE.costCache.set(agentDir, modelsJsonCostCache);
    }

    return getProviderCostIndex(modelsJsonCostCache.providers, normalizeKey);
  } catch {
    return EMPTY_PROVIDER_COST_INDEX;
  }
}

function resolveCostAgentDir(config?: OpenClawConfig, agentDir?: string): string | undefined {
  if (agentDir) {
    return agentDir;
  }
  if (config && listAgentEntries(config).length > 0) {
    const defaultAgentId = tryResolveDefaultAgentId(config);
    return defaultAgentId ? resolveAgentDir(config, defaultAgentId) : undefined;
  }
  // Config-less and pricing-only lookups are shipped APIs for the historical
  // main models.json. Full runtime configs resolve their roster default above.
  return path.join(resolveStateDir(), "agents", "main", "agent");
}

function stableCostFingerprintValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableCostFingerprintValue(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableCostFingerprintValue(record[key])}`)
    .join(",")}}`;
}

function serializeCostIndex(
  entries: Map<string, RawModelCostConfig>,
): Array<[string, RawModelCostConfig]> {
  return Array.from(entries.entries()).toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Fingerprints all model-pricing sources that can affect usage cost estimates.
 * Consumers cache this value to know when resolved cost entries need recomputation.
 */
export function resolveModelCostConfigFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
): string {
  return fingerprintModelCostPricing(config, agentDir, resolveModelPricingContext(config));
}

function fingerprintModelCostPricing(
  config: OpenClawConfig | undefined,
  agentDir: string | undefined,
  pricingContext: PricingContext,
): string {
  const resolvedAgentDir = resolveCostAgentDir(config, agentDir);
  const sourceConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : undefined;
  const serialized = stableCostFingerprintValue({
    configuredRaw: serializeCostIndex(getProviderCostIndex(sourceConfig?.models?.providers)),
    configuredNormalized: serializeCostIndex(
      getProviderCostIndex(sourceConfig?.models?.providers, pricingContext.normalizeKey),
    ),
    modelsJsonRaw: serializeCostIndex(loadModelsJsonCostIndex(resolvedAgentDir)),
    modelsJsonNormalized: serializeCostIndex(
      loadModelsJsonCostIndex(resolvedAgentDir, pricingContext.normalizeKey),
    ),
    catalogPricing: modelCatalogPricingFingerprint(pricingContext),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export type CapturedModelCostPricing = ReturnType<typeof captureModelCostPricing>;

/** Captures hosted rows, normalization policy, and prices for one usage operation. */
export function captureModelCostPricing(config?: OpenClawConfig, agentDir?: string) {
  const pricingContext = resolveModelPricingContext(config);
  return {
    fingerprint: () => fingerprintModelCostPricing(config, agentDir, pricingContext),
    resolve: (provider?: string, model?: string) =>
      resolveModelCostConfigWithPricing({ provider, model, config, agentDir }, pricingContext),
  };
}

/**
 * Resolves local models.json first, then authored overrides over effective catalog prices.
 * Complete direct prices need no plugin normalization or provider discovery.
 */
export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  allowPluginNormalization?: boolean;
}): ModelCostConfig | undefined {
  return resolveModelCostConfigWithPricing(params);
}

function resolveModelCostConfigWithPricing(
  params: Parameters<typeof resolveModelCostConfig>[0],
  capturedPricing?: PricingContext,
): ModelCostConfig | undefined {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const rawKey = normalizeRawModelKey(provider, model);
  const agentDir = resolveCostAgentDir(params.config, params.agentDir);
  // Favor direct configured keys first so local pricing/status lookups stay
  // synchronous and do not drag plugin/provider discovery into the hot path.
  const rawModelsJsonCost = loadModelsJsonCostIndex(agentDir).get(rawKey);
  if (hasModelCostRates(rawModelsJsonCost)) {
    return normalizeModelCostConfig(rawModelsJsonCost);
  }

  // Materialized catalog defaults are not authored overrides. Preserve raw
  // partial fields and empty tiers until merging with the inherited schedule.
  const sourceConfig = params.config
    ? projectConfigOntoRuntimeSourceSnapshot(params.config)
    : undefined;
  let configuredCost = getProviderCostIndex(sourceConfig?.models?.providers).get(rawKey);
  let pricingContext = capturedPricing;
  if (params.allowPluginNormalization !== false && !configuredCost) {
    pricingContext ??= resolveModelPricingContext(params.config);
    const key = pricingContext.normalizeKey(provider, model);
    const modelsJsonCost = loadModelsJsonCostIndex(agentDir, pricingContext.normalizeKey).get(key);
    if (hasModelCostRates(modelsJsonCost)) {
      return normalizeModelCostConfig(modelsJsonCost);
    }
    configuredCost = getProviderCostIndex(
      sourceConfig?.models?.providers,
      pricingContext.normalizeKey,
    ).get(key);
  }

  if (
    configuredCost &&
    configuredCost.input !== undefined &&
    configuredCost.output !== undefined &&
    configuredCost.cacheRead !== undefined &&
    configuredCost.cacheWrite !== undefined
  ) {
    return normalizeModelCostConfig(configuredCost);
  }
  // Display-only lookups reuse prepared prices without discovering plugins;
  // ordinary lookups inherit current catalog rates, never materialized defaults.
  if (params.allowPluginNormalization !== false) {
    pricingContext ??= resolveModelPricingContext(params.config);
  }
  const inheritedCost = pricingContext
    ? resolveModelPricing(pricingContext, pricingContext.normalizeKey(provider, model))
    : getProviderCostIndex(params.config?.models?.providers).get(rawKey);
  const merged = mergeModelCost(
    hasModelCostRates(inheritedCost) ? normalizeResolvedPricing(inheritedCost) : undefined,
    configuredCost,
  );
  return hasModelCostRates(merged) ? normalizeResolvedPricing(merged) : undefined;
}

/** Estimates one call's USD cost; tier selection includes cached prompt tokens. */
export function estimateUsageCost(params: {
  usage?: NormalizedUsage | null;
  cost?: ModelCostConfig;
  /** Captured physical-route rates: missing billable counters or prices remain unknown. */
  declaredCost?: Partial<Pick<ModelCostConfig, "input" | "output" | "cacheRead" | "cacheWrite">>;
}): number | undefined {
  const usage = params.usage;
  let cost = params.cost;
  if (params.declaredCost) {
    const buckets = ["input", "output", "cacheRead", "cacheWrite"] as const;
    if (!usage || !buckets.some((bucket) => usage[bucket] !== undefined)) {
      return undefined;
    }
    for (const bucket of buckets) {
      const count = usage[bucket];
      const rate = params.declaredCost[bucket];
      if (
        (count === undefined && rate !== 0) ||
        (count !== undefined && (!Number.isFinite(count) || count < 0)) ||
        (count !== 0 && (rate === undefined || !Number.isFinite(rate) || rate < 0))
      ) {
        return undefined;
      }
    }
    cost = normalizeResolvedPricing(params.declaredCost);
  }
  if (!usage || !cost || usage.usageReport?.state === "unavailable") {
    return undefined;
  }
  const total = calculateUsageCost(usage, cost).total;
  return Number.isFinite(total) ? total : undefined;
}

/** Preserve summed per-call costs; aggregate tokens cannot reconstruct request tiers. */
export function estimateAggregateUsageCost(
  params: Parameters<typeof resolveModelCostConfig>[0] & {
    usage?: NormalizedUsage | null;
    cost?: ModelCostConfig;
  },
): number | undefined {
  const usage = params.usage;
  if (usage?.usageReport?.state === "unavailable") {
    return undefined;
  }
  if (usage?.costStatus) {
    return usage.costStatus === "complete" ? usage.cost?.total : undefined;
  }
  if (usage?.cost && hasRecordedUsageCost(usage.cost)) {
    return usage.cost.total;
  }
  const hasBillableBuckets =
    usage &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
      (value) => value !== undefined,
    );
  // Legacy run summaries can report billing without any token buckets.
  if (!hasBillableBuckets) {
    return usage?.cost?.total;
  }
  // Recorded totals own billing; discover fallback prices only for unpriced usage.
  const cost = params.cost ?? resolveModelCostConfig(params);
  if (usage?.cost && cost) {
    return usage.cost.total;
  }
  return cost?.tieredPricing?.length ? undefined : estimateUsageCost({ usage, cost });
}
