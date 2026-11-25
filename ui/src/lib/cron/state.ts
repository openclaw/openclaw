import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronStatus } from "../../api/types.ts";
import { DEFAULT_CRON_JOBS_FILTERS } from "./list-params.ts";
import type { CronJobsState } from "./types.ts";

export function createCronReadState<Row = CronJob>(
  snapshot: Partial<Pick<CronJobsState, "client" | "connected">> = {},
): CronJobsState<Row> {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    cronLoading: false,
    cronJobsError: null,
    cronJobsReadDenied: false,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsSnapshotRevision: null,
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    ...DEFAULT_CRON_JOBS_FILTERS,
    cronAgentId: null,
  };
}

export function readCronStatus(client: GatewayBrowserClient) {
  return client.request<CronStatus>("cron.status", {});
}
