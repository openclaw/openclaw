/**
 * Usage monitoring and aggregation logic.
 */

import type { ProviderUsage, UsageEntry, UsagePeriod, UsageTotals } from "./types.js";
import { cacheGet, cacheSet, CACHE_KEYS, CACHE_TTL } from "../../infra/cache/index.js";
import { isRedisConnected } from "../../infra/cache/redis.js";
import { isDatabaseConnected } from "../../infra/database/index.js";
import { calculateCost, getProviderById } from "./registry.js";
import { queryUsage, recordUsage } from "./usage-store.js";

/**
 * Track a model usage event.
 * Called after each LLM API call to record tokens used.
 */
export async function trackUsage(params: {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  agentId?: string;
  sessionId?: string;
}): Promise<void> {
  const cost = calculateCost({
    providerId: params.providerId,
    modelId: params.modelId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens,
    cacheWriteTokens: params.cacheWriteTokens,
  });

  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    providerId: params.providerId,
    modelId: params.modelId,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cacheReadTokens: params.cacheReadTokens,
    cacheWriteTokens: params.cacheWriteTokens,
    cost,
    durationMs: params.durationMs,
    agentId: params.agentId,
    sessionId: params.sessionId,
  };

  // Record to database (fire and forget, don't block)
  recordUsage(entry).catch((err) => {
    console.error("Failed to record usage:", err);
  });

  // Invalidate cache for affected periods
  if (await isRedisConnected()) {
    await invalidateUsageCache(params.providerId);
  }
}

/**
 * Invalidate cached usage data for a provider.
 */
async function invalidateUsageCache(providerId: string): Promise<void> {
  try {
    await Promise.all([
      cacheSet(CACHE_KEYS.usageToday(providerId), null, { ttlSeconds: 1 }),
      cacheSet(CACHE_KEYS.usageWeek(providerId), null, { ttlSeconds: 1 }),
      cacheSet(CACHE_KEYS.usageMonth(providerId), null, { ttlSeconds: 1 }),
    ]);
  } catch {
    // Ignore cache errors
  }
}

/**
 * Get usage statistics with caching.
 */
export async function getUsage(params: {
  period?: UsagePeriod;
  providerId?: string;
  modelId?: string;
}): Promise<{
  usage: ProviderUsage[];
  totals: UsageTotals;
}> {
  const period = params.period ?? "all";

  // Try cache first for provider-specific queries
  if (params.providerId && !params.modelId && (await isRedisConnected())) {
    const cacheKey =
      period === "today"
        ? CACHE_KEYS.usageToday(params.providerId)
        : period === "week"
          ? CACHE_KEYS.usageWeek(params.providerId)
          : period === "month"
            ? CACHE_KEYS.usageMonth(params.providerId)
            : null;

    if (cacheKey) {
      const cached = await cacheGet<{ usage: ProviderUsage[]; totals: UsageTotals }>(cacheKey);
      if (cached) {
        return cached;
      }
    }
  }

  // Query database
  const usage = await queryUsage({
    period,
    providerId: params.providerId,
    modelId: params.modelId,
  });

  const totals = usage.reduce(
    (acc, u) => ({
      requests: acc.requests + u.requests,
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + (u.cacheReadTokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
      estimatedCost: acc.estimatedCost + u.estimatedCost,
    }),
    {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    },
  );

  const result = { usage, totals };

  // Cache the result
  if (params.providerId && !params.modelId && (await isRedisConnected())) {
    const cacheKey =
      period === "today"
        ? CACHE_KEYS.usageToday(params.providerId)
        : period === "week"
          ? CACHE_KEYS.usageWeek(params.providerId)
          : period === "month"
            ? CACHE_KEYS.usageMonth(params.providerId)
            : null;

    if (cacheKey) {
      await cacheSet(cacheKey, result, { ttlSeconds: CACHE_TTL.usageStats });
    }
  }

  return result;
}

/**
 * Check if usage tracking infrastructure is available.
 */
export async function isUsageTrackingAvailable(): Promise<{
  database: boolean;
  cache: boolean;
}> {
  const [database, cache] = await Promise.all([isDatabaseConnected(), isRedisConnected()]);
  return { database, cache };
}

/**
 * Format usage for display.
 */
export function formatUsageForDisplay(usage: ProviderUsage[]): {
  rows: {
    provider: string;
    model: string;
    requests: string;
    inputTokens: string;
    outputTokens: string;
    cost: string;
  }[];
  totals: {
    requests: string;
    inputTokens: string;
    outputTokens: string;
    cost: string;
  };
} {
  const formatNumber = (n: number) => n.toLocaleString();
  const formatCost = (n: number) => `$${n.toFixed(2)}`;

  const rows = usage.map((u) => {
    const provider = getProviderById(u.providerId);
    return {
      provider: provider?.name ?? u.providerId,
      model: u.modelId,
      requests: formatNumber(u.requests),
      inputTokens: formatNumber(u.inputTokens),
      outputTokens: formatNumber(u.outputTokens),
      cost: formatCost(u.estimatedCost),
    };
  });

  const totals = usage.reduce(
    (acc, u) => ({
      requests: acc.requests + u.requests,
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cost: acc.cost + u.estimatedCost,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  );

  return {
    rows,
    totals: {
      requests: formatNumber(totals.requests),
      inputTokens: formatNumber(totals.inputTokens),
      outputTokens: formatNumber(totals.outputTokens),
      cost: formatCost(totals.cost),
    },
  };
}
