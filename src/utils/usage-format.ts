/** Pure token-cost arithmetic and formatting for usage summaries. */
import {
  calculateUsageCost,
  normalizeResolvedPricing,
  type ModelCostConfig,
} from "@openclaw/llm-core";
import { hasRecordedUsageCost, type NormalizedUsage } from "../agents/usage.js";
import type { UsageCacheStatus } from "../infra/session-cost-usage.types.js";

export type { ModelCostConfig } from "@openclaw/llm-core";

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

/**
 * An all-zero transport cost is a placeholder; the resolved price owns it, authored zero included.
 * A sum below the second tier keeps every call in the first tier, so only that sum is exact.
 */
function estimateUnpricedAggregateUsageCost(
  usage: NormalizedUsage,
  cost: ModelCostConfig | undefined,
): number | undefined {
  const secondTierStart = cost?.tieredPricing
    ?.map((tier) => tier.range[0])
    .toSorted((a, b) => a - b)[1];
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return secondTierStart !== undefined && promptTokens >= secondTierStart
    ? undefined
    : estimateUsageCost({ usage, cost });
}
