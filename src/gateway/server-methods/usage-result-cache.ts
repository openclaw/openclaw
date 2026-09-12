import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../infra/session-cost-usage-totals.js";
import {
  loadCostUsageSummaryFromCache,
  type CostUsageSummary,
  type CostUsageTotals,
  type UsageCacheStatus,
  type UsageDailyBucket,
} from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import { loadUsageResultCached, type UsageCacheEntry } from "./usage-cache.js";
import { mergeUsageCacheStatus, runUsageAgentTasks } from "./usage-session-loading.js";
import type { UsageGroupingMode } from "./usage-session-selection.js";

const costUsageCache = new Map<string, UsageCacheEntry<CostUsageSummary>>();
const sessionsUsageCache = new Map<string, UsageCacheEntry<SessionsUsageResult>>();

function usageDayBucketCacheKey(dayBucket: UsageDailyBucket | undefined): string {
  return dayBucket
    ? dayBucket.mode === "time-zone"
      ? `time-zone:${dayBucket.timeZone}`
      : `utc-offset:${dayBucket.utcOffsetMinutes}`
    : "gateway";
}

type SessionsUsageCacheKeyParams = {
  configRef: object;
  visibilityIdentity?: string;
  agentId?: string;
  agentScope?: "all";
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  limit: number;
  groupingMode: UsageGroupingMode;
  specificKey: string | null;
  includeContextWeight: boolean;
};

// Every normalized query axis that can change response bytes belongs in this
// key; the 30s TTL mirrors usage.cost and keeps dashboard refreshes coherent.
function sessionsUsageCacheKey(params: SessionsUsageCacheKeyParams): string {
  return JSON.stringify([
    params.agentScope === "all" ? "all" : `agent:${params.agentId}`,
    params.startMs,
    params.endMs,
    params.includeUntimestamped === true,
    usageDayBucketCacheKey(params.dayBucket),
    params.limit,
    params.groupingMode,
    params.specificKey,
    params.includeContextWeight,
    ...(params.visibilityIdentity ? [params.visibilityIdentity] : []),
  ]);
}

export async function loadSessionsUsageResultCached(
  params: SessionsUsageCacheKeyParams & {
    load: () => Promise<SessionsUsageResult>;
  },
): Promise<SessionsUsageResult> {
  return await loadUsageResultCached({
    cache: sessionsUsageCache,
    cacheKey: sessionsUsageCacheKey(params),
    configRef: params.configRef,
    load: params.load,
    // Incomplete lower-cache snapshots must not acquire the outer freshness TTL.
    isComplete: (result) => !result.cacheStatus || result.cacheStatus.status === "fresh",
  });
}

export async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
  agentId?: string;
  agentScope?: "all";
}): Promise<CostUsageSummary> {
  const allAgents = params.agentScope === "all";
  const agentId = allAgents
    ? undefined
    : normalizeAgentId(params.agentId ?? resolveSessionAgentId({ config: params.config }));
  const dayBucketKey = usageDayBucketCacheKey(params.dayBucket);
  const cacheKey = `${allAgents ? "all" : `agent:${agentId}`}:${params.startMs}-${params.endMs}:${dayBucketKey}`;
  return await loadUsageResultCached({
    cache: costUsageCache,
    cacheKey,
    configRef: params.config,
    load: () =>
      allAgents
        ? loadAllAgentCostUsageSummary({
            startMs: params.startMs,
            endMs: params.endMs,
            dayBucket: params.dayBucket,
            config: params.config,
          })
        : loadCostUsageSummaryFromCache({
            startMs: params.startMs,
            endMs: params.endMs,
            dayBucket: params.dayBucket,
            config: params.config,
            agentId: expectDefined(agentId, "non-aggregate usage agent id"),
            requestRefresh: true,
            refreshMode: "background",
          }),
  });
}

async function loadAllAgentCostUsageSummary(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  // Same agent universe as discoverAllSessionsForUsage: enumerating configured
  // ids only would list system-agent sessions whose cost never reaches totals.
  const agentIds = listGatewayAgentsBasic(params.config).agents.map((agent) =>
    normalizeAgentId(agent.id),
  );
  const summaries = await runUsageAgentTasks(
    agentIds.map(
      (agentId) => () =>
        loadCostUsageSummaryFromCache({
          startMs: params.startMs,
          endMs: params.endMs,
          dayBucket: params.dayBucket,
          config: params.config,
          agentId,
          requestRefresh: true,
          refreshMode: "background",
        }),
    ),
  );
  const dailyByDate = new Map<string, CostUsageTotals & { date: string }>();
  const totals = createEmptyCostUsageTotals();
  let cacheStatus: UsageCacheStatus | undefined;
  let updatedAt = 0;
  let days = 0;
  for (const summary of summaries) {
    updatedAt = Math.max(updatedAt, summary.updatedAt);
    days = Math.max(days, summary.days);
    addCostUsageTotals(totals, summary.totals);
    if (summary.cacheStatus) {
      cacheStatus = mergeUsageCacheStatus(cacheStatus, summary.cacheStatus);
    }
    for (const day of summary.daily) {
      const entry = dailyByDate.get(day.date) ?? {
        date: day.date,
        ...createEmptyCostUsageTotals(),
      };
      addCostUsageTotals(entry, day);
      dailyByDate.set(day.date, entry);
    }
  }
  return {
    updatedAt,
    days,
    daily: Array.from(dailyByDate.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}
