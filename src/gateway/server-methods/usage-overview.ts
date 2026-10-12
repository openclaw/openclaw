import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadSessionCostOverviewFromCache,
  type UsageDailyBucket,
  type UsageCacheStatus,
} from "../../infra/session-cost-usage.js";
import { mergeUsageOverviews } from "../../shared/usage-overview.js";
import type { UsageOverviewSession, UsageOverviewOptions } from "../../shared/usage-types.js";
import { mergeUsageCacheStatus, runUsageAgentTasks } from "./usage-session-loading.js";

export async function loadUsageOverview(params: {
  sessions: UsageOverviewSession[];
  options: UsageOverviewOptions;
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  projection?: "overview";
}) {
  const byAgent = new Map<string, UsageOverviewSession[]>();
  for (const session of params.sessions) {
    const agentId = session.agentId;
    const sessions = byAgent.get(agentId) ?? [];
    sessions.push(session);
    byAgent.set(agentId, sessions);
  }
  const slices = await runUsageAgentTasks(
    [...byAgent].map(
      ([agentId, sessions]) =>
        () =>
          loadSessionCostOverviewFromCache({ ...params, sessions, agentId }),
    ),
  );
  let cacheStatus: UsageCacheStatus | undefined;
  for (const slice of slices) {
    cacheStatus = mergeUsageCacheStatus(cacheStatus, slice.cacheStatus);
  }
  return { ...mergeUsageOverviews(slices, params.options), cacheStatus };
}
