import type { CronListParams } from "../../../../packages/gateway-protocol/src/schema/cron.types.ts";
import type { CronJobsState } from "./types.ts";

export const DEFAULT_CRON_JOBS_FILTERS = {
  cronJobsLimit: 50,
  cronJobsQuery: "",
  cronJobsEnabledFilter: "all",
  cronJobsScheduleKindFilter: "all",
  cronJobsLastStatusFilter: "all",
  cronJobsTriggerFilter: "all",
  cronJobsSortBy: "nextRunAtMs",
  cronJobsSortDir: "asc",
} as const;

export function buildCronJobsListParams(
  state: Pick<
    CronJobsState,
    keyof typeof DEFAULT_CRON_JOBS_FILTERS | "cronAgentId" | "cronSessionFilter"
  >,
  options: { offset?: number; tableFilters?: boolean } = {},
): Omit<CronListParams, "compact"> {
  return {
    ...(state.cronSessionFilter ?? (state.cronAgentId ? { agentId: state.cronAgentId } : {})),
    includeDisabled: state.cronJobsEnabledFilter === "all",
    includeDeliveryPreviews: false,
    limit: state.cronJobsLimit,
    offset: options.offset ?? 0,
    query: state.cronJobsQuery.trim() || undefined,
    enabled: state.cronJobsEnabledFilter,
    ...(options.tableFilters
      ? {
          scheduleKind: state.cronJobsScheduleKindFilter,
          lastRunStatus: state.cronJobsLastStatusFilter,
          trigger: state.cronJobsTriggerFilter,
        }
      : {}),
    sortBy: state.cronJobsSortBy,
    sortDir: state.cronJobsSortDir,
  };
}
