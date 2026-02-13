import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionSystemPromptReport } from "../../config/sessions/types.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionLatencyStats,
  SessionModelUsage,
  SessionToolUsage,
} from "../../infra/session-cost-usage.js";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveSessionFilePath } from "../../config/sessions/paths.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import {
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  type DiscoveredSession,
} from "../../infra/session-cost-usage.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../protocol/index.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
} from "../session-utils.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;

type DateRange = { startMs: number; endMs: number };

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

/**
 * Parse a date string (YYYY-MM-DD) to start of day timestamp in UTC.
 * Returns undefined if invalid.
 */
const parseDateToMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  // Use UTC to ensure consistent behavior across timezones
  const ms = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day));
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return ms;
};

const parseDays = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
}): DateRange => {
  const now = new Date();
  // Use UTC for consistent date handling
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayEndMs = todayStartMs + 24 * 60 * 60 * 1000 - 1;

  const startMs = parseDateToMs(params.startDate);
  const endMs = parseDateToMs(params.endDate);

  if (startMs !== undefined && endMs !== undefined) {
    // endMs should be end of day
    return { startMs, endMs: endMs + 24 * 60 * 60 * 1000 - 1 };
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    const start = todayStartMs - (clampedDays - 1) * 24 * 60 * 60 * 1000;
    return { startMs: start, endMs: todayEndMs };
  }

  // Default to last 30 days
  const defaultStartMs = todayStartMs - 29 * 24 * 60 * 60 * 1000;
  return { startMs: defaultStartMs, endMs: todayEndMs };
};

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };

async function discoverAllSessionsForUsage(params: {
  config: ReturnType<typeof loadConfig>;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const agents = listAgentsForGateway(params.config).agents;
  const results = await Promise.all(
    agents.map(async (agent) => {
      const sessions = await discoverAllSessions({
        agentId: agent.id,
        startMs: params.startMs,
        endMs: params.endMs,
      });
      return sessions.map((session) => ({ ...session, agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: ReturnType<typeof loadConfig>;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummary({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
  })
    .then((summary) => {
      costUsageCache.set(cacheKey, { summary, updatedAt: Date.now() });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        costUsageCache.set(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

// Exposed for unit tests (kept as a single export to avoid widening the public API surface).
export const __test = {
  parseDateToMs,
  parseDays,
  parseDateRange,
  discoverAllSessionsForUsage,
  loadCostUsageSummaryCached,
  costUsageCache,
};

export type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
  aggregates: SessionsUsageAggregates;
};

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = typeof p.key === "string" ? p.key.trim() : null;

    // Load session store for named sessions
    const { storePath, store } = loadCombinedSessionStoreForGateway(config);
    const now = Date.now();

    // Merge discovered sessions with store entries
    type MergedEntry = {
      key: string;
      sessionId: string;
      sessionFile: string;
      label?: string;
      updatedAt: number;
      storeEntry?: SessionEntry;
      firstUserMessage?: string;
    };

    const mergedEntries: MergedEntry[] = [];

    // Optimization: If a specific key is requested, skip full directory scan
    if (specificKey) {
      const parsed = parseAgentSessionKey(specificKey);
      const agentIdFromKey = parsed?.agentId;
      const keyRest = parsed?.rest ?? specificKey;

      // Prefer the store entry when available, even if the caller provides a discovered key
      // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
      const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
      for (const [key, entry] of Object.entries(store)) {
        if (entry?.sessionId) {
          storeBySessionId.set(entry.sessionId, { key, entry });
        }
      }

      const storeMatch = store[specificKey]
        ? { key: specificKey, entry: store[specificKey] }
        : null;
      const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
      const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
      const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
      const sessionId = storeEntry?.sessionId ?? keyRest;

      // Resolve the session file path
      let sessionFile: string;
      try {
        const pathOpts =
          storePath && storePath !== "(multiple)"
            ? { sessionsDir: path.dirname(storePath) }
            : { agentId: agentIdFromKey };
        sessionFile = resolveSessionFilePath(sessionId, storeEntry, pathOpts);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`),
        );
        return;
      }

      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          mergedEntries.push({
            key: resolvedStoreKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
            storeEntry,
          });
        }
      } catch {
        // File doesn't exist - no results for this key
      }
    } else {
      // Full discovery for list view
      const discoveredSessions = await discoverAllSessionsForUsage({
        config,
        startMs,
        endMs,
      });

      // Build a map of sessionId -> store entry for quick lookup
      const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
      for (const [key, entry] of Object.entries(store)) {
        if (entry?.sessionId) {
          storeBySessionId.set(entry.sessionId, { key, entry });
        }
      }

      for (const discovered of discoveredSessions) {
        const storeMatch = storeBySessionId.get(discovered.sessionId);
        if (storeMatch) {
          // Named session from store
          mergedEntries.push({
            key: storeMatch.key,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: storeMatch.entry.label,
            updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
            storeEntry: storeMatch.entry,
          });
        } else {
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: undefined, // No label for unnamed sessions
            updatedAt: discovered.mtime,
          });
        }
      }
    }

    // Sort by most recent first
    mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

    // Apply limit
    const limitedEntries = mergedEntries.slice(0, limit);

    // Load usage for each session
    const sessions: SessionUsageEntry[] = [];
    const aggregateTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const aggregateMessages: SessionMessageCounts = {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
    const toolAggregateMap = new Map<string, number>();
    const byModelMap = new Map<string, SessionModelUsage>();
    const byProviderMap = new Map<string, SessionModelUsage>();
    const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
    const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
    const dailyAggregateMap = new Map<
      string,
      {
        date: string;
        tokens: number;
        cost: number;
        messages: number;
        toolCalls: number;
        errors: number;
      }
    >();
    const latencyTotals = {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      p95Max: 0,
    };
    const dailyLatencyMap = new Map<
      string,
      { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
    >();
    const modelDailyMap = new Map<string, SessionDailyModelUsage>();

    const emptyTotals = (): CostUsageSummary["totals"] => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    const mergeTotals = (
      target: CostUsageSummary["totals"],
      source: CostUsageSummary["totals"],
    ) => {
      target.input += source.input;
      target.output += source.output;
      target.cacheRead += source.cacheRead;
      target.cacheWrite += source.cacheWrite;
      target.totalTokens += source.totalTokens;
      target.totalCost += source.totalCost;
      target.inputCost += source.inputCost;
      target.outputCost += source.outputCost;
      target.cacheReadCost += source.cacheReadCost;
      target.cacheWriteCost += source.cacheWriteCost;
      target.missingCostEntries += source.missingCostEntries;
    };

    for (const merged of limitedEntries) {
      const usage = await loadSessionCostSummary({
        sessionId: merged.sessionId,
        sessionEntry: merged.storeEntry,
        sessionFile: merged.sessionFile,
        config,
        startMs,
        endMs,
      });

      if (usage) {
        aggregateTotals.input += usage.input;
        aggregateTotals.output += usage.output;
        aggregateTotals.cacheRead += usage.cacheRead;
        aggregateTotals.cacheWrite += usage.cacheWrite;
        aggregateTotals.totalTokens += usage.totalTokens;
        aggregateTotals.totalCost += usage.totalCost;
        aggregateTotals.inputCost += usage.inputCost;
        aggregateTotals.outputCost += usage.outputCost;
        aggregateTotals.cacheReadCost += usage.cacheReadCost;
        aggregateTotals.cacheWriteCost += usage.cacheWriteCost;
        aggregateTotals.missingCostEntries += usage.missingCostEntries;
      }

      const agentId = parseAgentSessionKey(merged.key)?.agentId;
      const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
      const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;

      if (usage) {
        if (usage.messageCounts) {
          aggregateMessages.total += usage.messageCounts.total;
          aggregateMessages.user += usage.messageCounts.user;
          aggregateMessages.assistant += usage.messageCounts.assistant;
          aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
          aggregateMessages.toolResults += usage.messageCounts.toolResults;
          aggregateMessages.errors += usage.messageCounts.errors;
        }

        if (usage.toolUsage) {
          for (const tool of usage.toolUsage.tools) {
            toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
          }
        }

        if (usage.modelUsage) {
          for (const entry of usage.modelUsage) {
            const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const modelExisting =
              byModelMap.get(modelKey) ??
              ({
                provider: entry.provider,
                model: entry.model,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            modelExisting.count += entry.count;
            mergeTotals(modelExisting.totals, entry.totals);
            byModelMap.set(modelKey, modelExisting);

            const providerKey = entry.provider ?? "unknown";
            const providerExisting =
              byProviderMap.get(providerKey) ??
              ({
                provider: entry.provider,
                model: undefined,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            providerExisting.count += entry.count;
            mergeTotals(providerExisting.totals, entry.totals);
            byProviderMap.set(providerKey, providerExisting);
          }
        }

        if (usage.latency) {
          const { count, avgMs, minMs, maxMs, p95Ms } = usage.latency;
          if (count > 0) {
            latencyTotals.count += count;
            latencyTotals.sum += avgMs * count;
            latencyTotals.min = Math.min(latencyTotals.min, minMs);
            latencyTotals.max = Math.max(latencyTotals.max, maxMs);
            latencyTotals.p95Max = Math.max(latencyTotals.p95Max, p95Ms);
          }
        }

        if (usage.dailyLatency) {
          for (const day of usage.dailyLatency) {
            const existing = dailyLatencyMap.get(day.date) ?? {
              date: day.date,
              count: 0,
              sum: 0,
              min: Number.POSITIVE_INFINITY,
              max: 0,
              p95Max: 0,
            };
            existing.count += day.count;
            existing.sum += day.avgMs * day.count;
            existing.min = Math.min(existing.min, day.minMs);
            existing.max = Math.max(existing.max, day.maxMs);
            existing.p95Max = Math.max(existing.p95Max, day.p95Ms);
            dailyLatencyMap.set(day.date, existing);
          }
        }

        if (usage.dailyModelUsage) {
          for (const entry of usage.dailyModelUsage) {
            const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const existing =
              modelDailyMap.get(key) ??
              ({
                date: entry.date,
                provider: entry.provider,
                model: entry.model,
                tokens: 0,
                cost: 0,
                count: 0,
              } as SessionDailyModelUsage);
            existing.tokens += entry.tokens;
            existing.cost += entry.cost;
            existing.count += entry.count;
            modelDailyMap.set(key, existing);
          }
        }

        if (agentId) {
          const agentTotals = byAgentMap.get(agentId) ?? emptyTotals();
          mergeTotals(agentTotals, usage);
          byAgentMap.set(agentId, agentTotals);
        }

        if (channel) {
          const channelTotals = byChannelMap.get(channel) ?? emptyTotals();
          mergeTotals(channelTotals, usage);
          byChannelMap.set(channel, channelTotals);
        }

        if (usage.dailyBreakdown) {
          for (const day of usage.dailyBreakdown) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.tokens += day.tokens;
            daily.cost += day.cost;
            dailyAggregateMap.set(day.date, daily);
          }
        }

        if (usage.dailyMessageCounts) {
          for (const day of usage.dailyMessageCounts) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.messages += day.total;
            daily.toolCalls += day.toolCalls;
            daily.errors += day.errors;
            dailyAggregateMap.set(day.date, daily);
          }
        }
      }

      sessions.push({
        key: merged.key,
        label: merged.label,
        sessionId: merged.sessionId,
        updatedAt: merged.updatedAt,
        agentId,
        channel,
        chatType,
        origin: merged.storeEntry?.origin,
        modelOverride: merged.storeEntry?.modelOverride,
        providerOverride: merged.storeEntry?.providerOverride,
        modelProvider: merged.storeEntry?.modelProvider,
        model: merged.storeEntry?.model,
        usage,
        contextWeight: includeContextWeight
          ? (merged.storeEntry?.systemPromptReport ?? null)
          : undefined,
      });
    }

    // Format dates back to YYYY-MM-DD strings
    const formatDateStr = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    const aggregates: SessionsUsageAggregates = {
      messages: aggregateMessages,
      tools: {
        totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolAggregateMap.size,
        tools: Array.from(toolAggregateMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      },
      byModel: Array.from(byModelMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byAgent: Array.from(byAgentMap.entries())
        .map(([id, totals]) => ({ agentId: id, totals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      byChannel: Array.from(byChannelMap.entries())
        .map(([name, totals]) => ({ channel: name, totals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      latency:
        latencyTotals.count > 0
          ? {
              count: latencyTotals.count,
              avgMs: latencyTotals.sum / latencyTotals.count,
              minMs: latencyTotals.min === Number.POSITIVE_INFINITY ? 0 : latencyTotals.min,
              maxMs: latencyTotals.max,
              p95Ms: latencyTotals.p95Max,
            }
          : undefined,
      dailyLatency: Array.from(dailyLatencyMap.values())
        .map((entry) => ({
          date: entry.date,
          count: entry.count,
          avgMs: entry.count ? entry.sum / entry.count : 0,
          minMs: entry.min === Number.POSITIVE_INFINITY ? 0 : entry.min,
          maxMs: entry.max,
          p95Ms: entry.p95Max,
        }))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
      modelDaily: Array.from(modelDailyMap.values()).toSorted(
        (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
      ),
      daily: Array.from(dailyAggregateMap.values()).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      ),
    };

    const result: SessionsUsageResult = {
      updatedAt: now,
      startDate: formatDateStr(startMs),
      endDate: formatDateStr(endMs),
      sessions,
      totals: aggregateTotals,
      aggregates,
    };

    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const config = loadConfig();
    const { entry, storePath } = loadSessionEntry(key);

    // For discovered sessions (not in store), try using key as sessionId directly
    const parsed = parseAgentSessionKey(key);
    const agentId = parsed?.agentId;
    const rawSessionId = parsed?.rest ?? key;
    const sessionId = entry?.sessionId ?? rawSessionId;
    let sessionFile: string;
    try {
      const pathOpts = storePath ? { sessionsDir: path.dirname(storePath) } : { agentId };
      sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
      );
      return;
    }

    const timeseries = await loadSessionUsageTimeSeries({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const config = loadConfig();
    const { entry, storePath } = loadSessionEntry(key);

    // For discovered sessions (not in store), try using key as sessionId directly
    const parsed = parseAgentSessionKey(key);
    const agentId = parsed?.agentId;
    const rawSessionId = parsed?.rest ?? key;
    const sessionId = entry?.sessionId ?? rawSessionId;
    let sessionFile: string;
    try {
      const pathOpts = storePath ? { sessionsDir: path.dirname(storePath) } : { agentId };
      sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
      );
      return;
    }

    const { loadSessionLogs } = await import("../../infra/session-cost-usage.js");
    const logs = await loadSessionLogs({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      limit,
    });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
