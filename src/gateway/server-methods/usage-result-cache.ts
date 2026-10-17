import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionCostUsageUpdatedAt } from "../../infra/session-cost-usage-events.js";
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
import { getActiveRemoteModelCatalog } from "../../model-catalog/remote-overlay.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  readSessionRowChangeRevision,
  readWithSessionStoreTopology,
} from "../../sessions/session-row-changes.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { readUserProfileVersion } from "../../state/user-profile-events.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { loadUsageResultCached, type UsageCacheEntry } from "./usage-cache.js";
import { mergeUsageCacheStatus, runUsageAgentTasks } from "./usage-session-loading.js";
import type { UsageSessionSelection, UsageGroupingMode } from "./usage-session-selection.js";

const costUsageCache = new Map<string, UsageCacheEntry<CostUsageSummary>>();
export type SessionsUsageSnapshot = Pick<
  SessionsUsageResult,
  "updatedAt" | "sessions" | "cacheStatus"
> & { sources: UsageSessionSelection[]; accessRevision: number; sessionRevision: number };
const sessionsUsageCache = new Map<string, UsageCacheEntry<SessionsUsageSnapshot>>();

function usageDayBucketCacheKey(dayBucket: UsageDailyBucket | undefined): string {
  return dayBucket
    ? dayBucket.mode === "time-zone"
      ? `time-zone:${dayBucket.timeZone}`
      : `utc-offset:${dayBucket.utcOffsetMinutes}`
    : "gateway";
}

type SessionsUsageCacheKeyParams = {
  configRef: OpenClawConfig;
  visibilityIdentity?: string;
  creatorKey?: string;
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
  overviewKey?: string;
};

// Revisions replace the value for a stable query instead of retaining every rollup.
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
    params.creatorKey,
    params.overviewKey,
    ...(params.visibilityIdentity ? [params.visibilityIdentity] : []),
  ]);
}

export async function loadSessionsUsageSnapshotCached(
  params: SessionsUsageCacheKeyParams & {
    load: () => Promise<SessionsUsageSnapshot>;
  },
): Promise<SessionsUsageSnapshot> {
  return await loadUsageResultCached({
    cache: sessionsUsageCache,
    maxEntries: 8,
    shareInFlight: false,
    cacheKey: sessionsUsageCacheKey(params),
    configRef: params.configRef,
    revision: `${readUserProfileVersion()}:${getSessionCostUsageUpdatedAt()}:${readSessionRowChangeRevision()}:${readSessionTranscriptUpdateVersion()}:${readGatewayAccessRevision()}:${getActiveRemoteModelCatalog(params.configRef)?.revision ?? ""}`,
    revisionOnly: params.overviewKey !== undefined,
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
    revision: `${getSessionCostUsageUpdatedAt()}:${readSessionTranscriptUpdateVersion()}:${readSessionRowChangeRevision()}`,
    load: () =>
      allAgents
        ? loadAllAgentCostUsageSummary(params)
        : loadCostUsageSummaryFromCache({
            ...params,
            agentId: expectDefined(agentId, "non-aggregate usage agent id"),
            requestRefresh: true,
          }),
  });
}

async function loadAllAgentCostUsageSummary(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  return readWithSessionStoreTopology(async () => {
    // Same agent universe as discoverAllSessionsForUsage: enumerating configured
    // ids only would list system-agent sessions whose cost never reaches totals.
    const agentIds = (await listGatewayAgentsBasic(params.config)).agents.map((agent) =>
      normalizeAgentId(agent.id),
    );
    const summaries = await runUsageAgentTasks(
      agentIds.map(
        (agentId) => () =>
          loadCostUsageSummaryFromCache({
            ...params,
            agentId,
            requestRefresh: true,
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
  });
}
