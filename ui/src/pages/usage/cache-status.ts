import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionsUsageResult } from "./data-types.ts";

type UsageCacheStatus = SessionsUsageResult["cacheStatus"];

export function isUsageCacheIncomplete(
  sessionsStatus: UsageCacheStatus,
  costStatus: UsageCacheStatus,
): boolean {
  return [sessionsStatus, costStatus].some((cache) => cache && cache.status !== "fresh");
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
