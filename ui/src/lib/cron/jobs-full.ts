import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sortCronJobs } from "../../../../src/cron/service/list-page-sort.js";
import type { CronJob } from "../../api/types.ts";
import {
  isCronJobsScopeCurrent,
  loadCronJobsProjectionPage,
  type CronJobsPageOptions,
  type CronJobsProjection,
} from "./jobs.ts";
import { getCronJobPayload } from "./payload.ts";
import type { CronJobsState } from "./types.ts";

const fullCronJobsProjection: CronJobsProjection<CronJob> = {
  readRows: (rows) => rows.filter((job) => getCronJobPayload(job) !== null),
};

export function loadCronJobsPage(
  state: CronJobsState,
  opts?: CronJobsPageOptions & { event?: unknown },
) {
  if (applyCronJobsEvent(state, opts?.event)) {
    return Promise.resolve();
  }
  return loadCronJobsProjectionPage(state, fullCronJobsProjection, opts);
}

function applyCronJobsEvent(state: CronJobsState, payload: unknown): boolean {
  if (
    !state.connected ||
    state.canRefresh?.() === false ||
    state.cronLoading ||
    state.cronJobsLoadingMore ||
    state.cronJobsReloadPending ||
    !state.cronJobsSnapshotRevision ||
    state.cronJobsError ||
    state.cronJobsHasMore ||
    state.cronJobs.length !== state.cronJobsTotal ||
    !isCronJobsScopeCurrent(state) ||
    state.cronJobsLastStatusFilter !== "all" ||
    !isRecord(payload) ||
    !["started", "finished", "scheduled"].includes(String(payload.action)) ||
    !isRecord(payload.job) ||
    !isRecord(payload.job.state) ||
    payload.jobId !== payload.job.id
  ) {
    return false;
  }
  // The Gateway publishes these runtime facts as a complete compact snapshot.
  // Definitions, unknown membership, filtered status and incomplete windows still need a list read.
  const index = state.cronJobs.findIndex((job) => job.id === payload.jobId);
  const previous = state.cronJobs[index];
  if (
    !previous ||
    previous.name !== payload.job.name ||
    previous.agentId !== payload.job.agentId ||
    previous.enabled !== payload.job.enabled ||
    typeof payload.job.updatedAtMs !== "number"
  ) {
    return false;
  }
  if (payload.job.updatedAtMs < previous.updatedAtMs) {
    return true;
  }
  // SAFETY: The authenticated cron publisher owns this compact runtime projection.
  const runtime = payload.job.state as Pick<
    CronJob["state"],
    "nextRunAtMs" | "lastRunAtMs" | "lastRunStatus" | "lastStatus" | "runningAtMs" | "autoDisabled"
  >;
  const { nextRunAtMs, lastRunAtMs, lastRunStatus, lastStatus, runningAtMs, autoDisabled } =
    runtime;
  const next = {
    ...previous,
    updatedAtMs: payload.job.updatedAtMs,
    state: {
      ...previous.state,
      nextRunAtMs,
      lastRunAtMs,
      lastRunStatus,
      lastStatus,
      runningAtMs,
      autoDisabled,
      ...(payload.action === "finished"
        ? {
            lastError: typeof payload.error === "string" ? payload.error : undefined,
            lastDurationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
          }
        : {}),
    },
  };
  state.cronJobs = sortCronJobs(
    state.cronJobs.with(index, next),
    state.cronJobsSortBy,
    state.cronJobsSortDir,
  );
  return true;
}
