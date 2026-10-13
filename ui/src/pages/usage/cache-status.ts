import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionsUsageResult } from "./data-types.ts";
import type { UsageProps } from "./types.ts";

type UsageCacheStatus = SessionsUsageResult["cacheStatus"];

export function isUsageCacheIncomplete(
  sessionsStatus: UsageCacheStatus,
  costStatus: UsageCacheStatus,
): boolean {
  return [sessionsStatus, costStatus].some((cache) => cache && cache.status !== "fresh");
}

export function resolveUsageOverviewState(
  data: Pick<UsageProps["data"], "cacheRefresh" | "loading" | "totals" | "sessions" | "costDaily">,
): { hasOverviewData: boolean; loadingOverview: boolean } {
  // Cold caches can list sessions before any usage has been read. Zero-filled
  // aggregate objects are not evidence of zero usage while that read is pending.
  const awaitingUsage =
    data.cacheRefresh !== "complete" &&
    !data.totals?.totalTokens &&
    !data.totals?.totalCost &&
    !data.sessions.some(
      (session) =>
        session.usage?.computedAt !== undefined ||
        session.usage?.totalTokens ||
        session.usage?.totalCost,
    ) &&
    !data.costDaily.some((day) => day.totalTokens || day.totalCost);
  const hasOverviewData =
    !awaitingUsage && Boolean(data.totals || data.sessions.length || data.costDaily.length);
  const loadingOverview = data.loading || (awaitingUsage && data.cacheRefresh === "retrying");
  return { hasOverviewData, loadingOverview };
}

export function resolveUsagePublication(
  publications: ApplicationGatewaySnapshot["usagePublications"],
  agentId?: string,
) {
  let updatedAt = 0;
  let committedAt = 0;
  const failures: NonNullable<ApplicationGatewaySnapshot["usagePublications"]>[string][] = [];
  for (const publication of agentId
    ? [publications && Object.hasOwn(publications, agentId) ? publications[agentId] : undefined]
    : Object.values(publications ?? {})) {
    if (!publication) {
      continue;
    }
    updatedAt = Math.max(updatedAt, publication.usageUpdatedAt);
    committedAt = Math.max(committedAt, publication.committedAt);
    if (publication.usageRefreshFailed) {
      failures.push(publication);
    }
  }
  return { updatedAt, committedAt, failures };
}
