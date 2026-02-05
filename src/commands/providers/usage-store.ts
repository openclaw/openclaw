/**
 * Usage store for persisting LLM usage data to TimescaleDB.
 */

import type { ProviderUsage, UsageEntry, UsagePeriod, UsageTotals } from "./types.js";
import {
  getDatabase,
  isDatabaseConnected,
  type LlmUsageInsert,
} from "../../infra/database/index.js";
import { calculateCost } from "./registry.js";

/**
 * Record a usage entry to the database.
 */
export async function recordUsage(entry: UsageEntry): Promise<boolean> {
  try {
    if (!(await isDatabaseConnected())) {
      return false;
    }

    const db = getDatabase();
    const cost =
      entry.cost ??
      calculateCost({
        providerId: entry.providerId,
        modelId: entry.modelId,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
      });

    const insert: LlmUsageInsert = {
      time: new Date(entry.timestamp),
      providerId: entry.providerId,
      modelId: entry.modelId,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      cacheWriteTokens: entry.cacheWriteTokens ?? 0,
      costUsd: cost,
      durationMs: entry.durationMs,
    };

    await db`
      INSERT INTO llm_usage (
        time,
        provider_id,
        model_id,
        agent_id,
        session_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_usd,
        duration_ms
      ) VALUES (
        ${insert.time ?? new Date()},
        ${insert.providerId},
        ${insert.modelId},
        ${insert.agentId ?? null},
        ${insert.sessionId ?? null},
        ${insert.inputTokens},
        ${insert.outputTokens},
        ${insert.cacheReadTokens ?? 0},
        ${insert.cacheWriteTokens ?? 0},
        ${insert.costUsd ?? null},
        ${insert.durationMs ?? null}
      )
    `;

    return true;
  } catch (error) {
    console.error("Failed to record usage:", error);
    return false;
  }
}

/**
 * Get the start time for a given period.
 */
function getPeriodStartTime(period: UsagePeriod): Date {
  const now = new Date();
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "month": {
      const start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "all":
      return new Date(0);
  }
}

/**
 * Query aggregated usage from the database.
 */
export async function queryUsage(params: {
  period?: UsagePeriod;
  providerId?: string;
  modelId?: string;
  agentId?: string;
}): Promise<ProviderUsage[]> {
  try {
    if (!(await isDatabaseConnected())) {
      return [];
    }

    const db = getDatabase();
    const period = params.period ?? "all";
    const startTime = getPeriodStartTime(period);

    type AggRow = {
      provider_id: string;
      model_id: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      total_cost: string | null;
      last_used: Date | null;
    };

    const rows = await db<AggRow[]>`
      SELECT
        provider_id,
        model_id,
        COUNT(*)::text AS requests,
        SUM(input_tokens)::text AS input_tokens,
        SUM(output_tokens)::text AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
        SUM(cost_usd)::text AS total_cost,
        MAX(time) AS last_used
      FROM llm_usage
      WHERE time >= ${startTime}
        ${params.providerId ? db`AND provider_id = ${params.providerId}` : db``}
        ${params.modelId ? db`AND model_id = ${params.modelId}` : db``}
        ${params.agentId ? db`AND agent_id = ${params.agentId}` : db``}
      GROUP BY provider_id, model_id
      ORDER BY SUM(cost_usd) DESC NULLS LAST, COUNT(*) DESC
    `;

    return rows.map((row) => ({
      providerId: row.provider_id,
      modelId: row.model_id,
      period,
      requests: parseInt(row.requests, 10),
      inputTokens: parseInt(row.input_tokens, 10),
      outputTokens: parseInt(row.output_tokens, 10),
      cacheReadTokens: parseInt(row.cache_read_tokens, 10),
      cacheWriteTokens: parseInt(row.cache_write_tokens, 10),
      estimatedCost: row.total_cost ? parseFloat(row.total_cost) : 0,
      lastUsed: row.last_used?.toISOString(),
    }));
  } catch (error) {
    console.error("Failed to query usage:", error);
    return [];
  }
}

/**
 * Get usage totals across all providers/models.
 */
export async function getUsageTotals(params: {
  period?: UsagePeriod;
  providerId?: string;
}): Promise<UsageTotals> {
  const usage = await queryUsage(params);
  return usage.reduce(
    (totals, u) => ({
      requests: totals.requests + u.requests,
      inputTokens: totals.inputTokens + u.inputTokens,
      outputTokens: totals.outputTokens + u.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + (u.cacheReadTokens ?? 0),
      cacheWriteTokens: totals.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
      estimatedCost: totals.estimatedCost + u.estimatedCost,
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
}

/**
 * Get usage by provider (aggregated across models).
 */
export async function getUsageByProvider(params: {
  period?: UsagePeriod;
}): Promise<Map<string, UsageTotals>> {
  const usage = await queryUsage(params);
  const byProvider = new Map<string, UsageTotals>();

  for (const u of usage) {
    const existing = byProvider.get(u.providerId) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    };

    byProvider.set(u.providerId, {
      requests: existing.requests + u.requests,
      inputTokens: existing.inputTokens + u.inputTokens,
      outputTokens: existing.outputTokens + u.outputTokens,
      cacheReadTokens: existing.cacheReadTokens + (u.cacheReadTokens ?? 0),
      cacheWriteTokens: existing.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
      estimatedCost: existing.estimatedCost + u.estimatedCost,
    });
  }

  return byProvider;
}

/**
 * Delete old usage data (retention policy).
 */
export async function deleteOldUsage(olderThanDays: number): Promise<number> {
  try {
    if (!(await isDatabaseConnected())) {
      return 0;
    }

    const db = getDatabase();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await db`
      DELETE FROM llm_usage
      WHERE time < ${cutoff}
    `;

    return result.count;
  } catch (error) {
    console.error("Failed to delete old usage:", error);
    return 0;
  }
}
