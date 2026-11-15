/**
 * Shared token/cost formatting and pricing lookup helpers for CLI, TUI, gateway, and status output.
 * Capture pricing asynchronously; rendering consumes the operation's prepared facts.
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
import {
  captureModelsJsonCostSource,
  type ModelKeyNormalizer,
} from "../agents/models-config-state.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import { hasRecordedUsageCost, type NormalizedUsage } from "../agents/usage.js";
import { mergeModelCost } from "../config/model-cost.js";
import { resolveStateDir } from "../config/paths.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UsageCacheStatus } from "../infra/session-cost-usage.types.js";
import {
  hasKnownPricing,
  modelCatalogPricingFingerprint,
  prepareModelPricingContext,
  resolveModelPricing,
  type PricingContext,
} from "../model-catalog/pricing.js";
export { formatTokenCount } from "./token-format.js";
export type { ModelCostConfig } from "@openclaw/llm-core";

const EMPTY_PROVIDER_COST_INDEX = new Map<string, RawModelCostConfig>();

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

function hasCompleteModelCost(
  cost: Partial<RawModelCostConfig> | undefined,
): cost is RawModelCostConfig {
  return (
    cost?.input !== undefined &&
    cost.output !== undefined &&
    cost.cacheRead !== undefined &&
    cost.cacheWrite !== undefined
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

async function loadModelsJsonCostSource(agentDir: string | undefined) {
  if (!agentDir) {
    return undefined;
  }
  try {
    return (await captureModelsJsonCostSource(agentDir)).providers;
  } catch {
    return undefined;
  }
}

function getModelsJsonCostIndex(
  providers: Record<string, ModelProviderConfig> | undefined,
  normalizeKey?: ModelKeyNormalizer,
) {
  try {
    return getProviderCostIndex(providers, normalizeKey);
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
export async function resolveModelCostConfigFingerprint(
  config?: OpenClawConfig,
  agentDir?: string,
): Promise<string> {
  return (await captureModelCostPricing(config, agentDir)).fingerprint();
}

function fingerprintModelCostPricing(
  config: OpenClawConfig | undefined,
  modelsProviders: Record<string, ModelProviderConfig> | undefined,
  pricingContext: PricingContext | undefined,
): string {
  const sourceConfig = config ? projectConfigOntoRuntimeSourceSnapshot(config) : undefined;
  const serialized = stableCostFingerprintValue({
    configuredRaw: serializeCostIndex(getProviderCostIndex(sourceConfig?.models?.providers)),
    configuredNormalized: serializeCostIndex(
      getProviderCostIndex(sourceConfig?.models?.providers, pricingContext?.normalizeKey),
    ),
    modelsJsonRaw: serializeCostIndex(getModelsJsonCostIndex(modelsProviders)),
    modelsJsonNormalized: serializeCostIndex(
      getModelsJsonCostIndex(modelsProviders, pricingContext?.normalizeKey),
    ),
    catalogPricing: pricingContext && modelCatalogPricingFingerprint(pricingContext),
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export type CapturedModelCostPricing = Awaited<ReturnType<typeof captureModelCostPricing>>;

/** Captures hosted rows, normalization policy, and prices for one usage operation. */
export async function captureModelCostPricing(
  config?: OpenClawConfig,
  agentDir?: string,
  allowPluginNormalization = true,
) {
  const modelsProviders = await loadModelsJsonCostSource(resolveCostAgentDir(config, agentDir));
  const pricingContext = allowPluginNormalization
    ? await prepareModelPricingContext(config)
    : undefined;
  return {
    fingerprint: () => fingerprintModelCostPricing(config, modelsProviders, pricingContext),
    resolve: (provider?: string, model?: string, normalize = allowPluginNormalization) =>
      resolveModelCostConfigWithPricing(
        { provider, model, config, agentDir, allowPluginNormalization: normalize },
        modelsProviders,
        pricingContext,
      ),
  };
}

type ModelCostLookup = {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  allowPluginNormalization?: boolean;
};

/**
 * Resolves local models.json first, then authored overrides over effective catalog prices.
 * Complete direct prices need no plugin normalization or provider discovery.
 */
export function resolveModelCostConfig(
  params: ModelCostLookup & { runtimeCost: RawModelCostConfig },
): Promise<RawModelCostConfig | undefined>;
export function resolveModelCostConfig(
  params: ModelCostLookup,
): Promise<ModelCostConfig | undefined>;
export async function resolveModelCostConfig(
  params: ModelCostLookup & {
    /** Already resolved runtime row; retain its authored-provider override rules before discovery. */
    runtimeCost?: RawModelCostConfig;
  },
): Promise<RawModelCostConfig | undefined> {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const modelsProviders = await loadModelsJsonCostSource(
    resolveCostAgentDir(params.config, params.agentDir),
  );
  const key = normalizeRawModelKey(provider, model);
  const localIndex = getModelsJsonCostIndex(modelsProviders);
  const source = params.config ? projectConfigOntoRuntimeSourceSnapshot(params.config) : undefined;
  const authoredIndex = getProviderCostIndex(source?.models?.providers);
  if (
    params.runtimeCost &&
    hasKnownPricing(params.runtimeCost) &&
    [authoredIndex, localIndex].some((index) =>
      [...index].some(
        ([modelKey, cost]) => modelKey.startsWith(`${provider}/`) && hasModelCostRates(cost),
      ),
    )
  ) {
    return params.runtimeCost;
  }
  const local = localIndex.get(key);
  if (hasModelCostRates(local)) {
    return normalizeModelCostConfig(local);
  }
  const authored = authoredIndex.get(key);
  if (hasCompleteModelCost(authored)) {
    return normalizeModelCostConfig(authored);
  }
  if (params.allowPluginNormalization === false) {
    return resolveModelCostConfigWithPricing(params, modelsProviders);
  }
  return resolveModelCostConfigWithPricing(
    params,
    modelsProviders,
    await prepareModelPricingContext(params.config),
  );
}

function resolveModelCostConfigWithPricing(
  params: Parameters<typeof resolveModelCostConfig>[0],
  modelsProviders: Record<string, ModelProviderConfig> | undefined,
  capturedPricing?: PricingContext,
): ModelCostConfig | undefined {
  const provider = normalizeProviderId(normalizeOptionalString(params.provider) ?? "");
  const model = normalizeOptionalString(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const rawKey = normalizeRawModelKey(provider, model);
  // Favor direct configured keys first so local pricing/status lookups stay
  // synchronous and do not drag plugin/provider discovery into the hot path.
  const rawModelsJsonCost = getModelsJsonCostIndex(modelsProviders).get(rawKey);
  if (hasModelCostRates(rawModelsJsonCost)) {
    return normalizeModelCostConfig(rawModelsJsonCost);
  }

  // Materialized catalog defaults are not authored overrides. Preserve raw
  // partial fields and empty tiers until merging with the inherited schedule.
  const sourceConfig = params.config
    ? projectConfigOntoRuntimeSourceSnapshot(params.config)
    : undefined;
  let configuredCost = getProviderCostIndex(sourceConfig?.models?.providers).get(rawKey);
  const pricingContext = capturedPricing;
  if (params.allowPluginNormalization !== false && !configuredCost && pricingContext) {
    const key = pricingContext.normalizeKey(provider, model);
    const modelsJsonCost = getModelsJsonCostIndex(modelsProviders, pricingContext.normalizeKey).get(
      key,
    );
    if (hasModelCostRates(modelsJsonCost)) {
      return normalizeModelCostConfig(modelsJsonCost);
    }
    configuredCost = getProviderCostIndex(
      sourceConfig?.models?.providers,
      pricingContext.normalizeKey,
    ).get(key);
  }

  if (hasCompleteModelCost(configuredCost)) {
    return normalizeModelCostConfig(configuredCost);
  }
  // Display-only lookups reuse prepared prices without discovering plugins;
  // ordinary lookups inherit current catalog rates, never materialized defaults.
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
export function estimateAggregateUsageCost(params: {
  usage?: NormalizedUsage | null;
  cost?: ModelCostConfig;
}): number | undefined {
  return resolveAggregateUsageCost(params.usage, (usage) =>
    estimateUnpricedAggregateUsageCost(usage, params.cost),
  );
}

/** Recorded totals and final unknowns settle before optional rate preparation. */
export async function estimateAggregateUsageCostAsync(params: {
  usage?: NormalizedUsage | null;
  prepareCost: () => Promise<ModelCostConfig | undefined>;
}): Promise<number | undefined> {
  return resolveAggregateUsageCost(params.usage, async (usage) =>
    estimateUnpricedAggregateUsageCost(usage, await params.prepareCost()),
  );
}

function resolveAggregateUsageCost<T>(
  usage: NormalizedUsage | null | undefined,
  estimate: (usage: NormalizedUsage) => T,
): number | undefined | T {
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
  return estimate(usage);
}

function estimateUnpricedAggregateUsageCost(
  usage: NormalizedUsage,
  cost: ModelCostConfig | undefined,
): number | undefined {
  if (usage.cost && cost) {
    return usage.cost.total;
  }
  return cost?.tieredPricing?.length ? undefined : estimateUsageCost({ usage, cost });
}
