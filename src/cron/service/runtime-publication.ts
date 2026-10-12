import type { CronJob } from "../types.js";
import { emit, type CronServiceState } from "./state.js";

/** Applies committed target rows locally without copying any unrelated store snapshot. */
export function applyCronRuntimeRowsToState(
  state: CronServiceState,
  jobs: Iterable<CronJob>,
  deletedJobIds: Iterable<string> = [],
  opts?: { publish?: boolean },
): void {
  if (!state.store) {
    return;
  }
  const jobsById = new Map([...jobs].map((job) => [job.id, job] as const));
  const deleted = new Set(deletedJobIds);
  const residentJobIds = new Set(state.store.jobs.map((job) => job.id));
  const residentJobs = state.store.jobs
    .filter((job) => !deleted.has(job.id))
    .map((job) => jobsById.get(job.id) ?? job);
  const importedJobs = [...jobsById.values()].filter(
    (job) => !residentJobIds.has(job.id) && !deleted.has(job.id),
  );
  state.store.jobs = [...residentJobs, ...importedJobs];
  if (opts?.publish !== false) {
    publishCronRuntimeRows(state);
  }
}

export function publishDurableNextRunChanges(params: {
  state: CronServiceState;
  storeJobs: readonly CronJob[];
  suppressScheduledJobId?: string;
}) {
  const previous = params.state.durableNextRunAtMsByJobId;
  const next = new Map(params.storeJobs.map((job) => [job.id, job.state.nextRunAtMs] as const));

  const changedJobs = params.storeJobs.filter((job) => {
    if (!previous.has(job.id) || !next.has(job.id)) {
      return false;
    }
    return previous.get(job.id) !== next.get(job.id);
  });

  // Advance durable truth before callbacks so re-entrant observers cannot
  // publish the same committed transition twice.
  params.state.durableNextRunAtMsByJobId = next;
  for (const job of changedJobs) {
    if (job.id === params.suppressScheduledJobId) {
      continue;
    }
    emit(params.state, {
      jobId: job.id,
      action: "scheduled",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
}

/** Publishes scheduled-row changes after a targeted runtime transaction commits. */
export function publishCronRuntimeRows(state: CronServiceState): void {
  if (!state.store) {
    return;
  }
  publishDurableNextRunChanges({ state, storeJobs: state.store.jobs });
}
