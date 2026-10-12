import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUsageCostWorkerDayBucket } from "../../infra/session-cost-usage-worker-runtime.js";
import {
  loadSessionCostOverviewFromCache,
  type UsageDailyBucket,
} from "../../infra/session-cost-usage.js";
import { buildUsageOverview } from "../../shared/usage-overview.js";
import type { UsageOverviewSession, UsageOverviewOptions } from "../../shared/usage-types.js";
import { loadUsageSessionSummaries } from "./usage-session-loading.js";

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
  const agentId = params.sessions[0]?.agentId;
  if (agentId && params.sessions.every((session) => session.agentId === agentId)) {
    return loadSessionCostOverviewFromCache({ ...params, agentId });
  }
  // Cross-agent addition must follow global session order; adding agent subtotals changes floats.
  const { summaries, cacheStatus } = await loadUsageSessionSummaries({
    ...params,
    entries: params.sessions,
  });
  return {
    ...buildUsageOverview({
      rows: params.sessions.map(({ instances: _instances, ...row }, index) => {
        const usage = summaries[index] ?? null;
        return Object.assign(row, { usage }, usage ? {} : { computing: true });
      }),
      options: params.options,
      dayBucket: resolveUsageCostWorkerDayBucket(params.dayBucket),
      compact: params.projection === "overview",
    }),
    cacheStatus,
  };
}
