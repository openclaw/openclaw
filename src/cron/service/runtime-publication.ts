import type { CronJob } from "../types.js";
import { emit, type CronServiceState } from "./state.js";

function durableNextRunsFromJobs(jobs: readonly CronJob[]) {
  return new Map(jobs.map((job) => [job.id, job.state.nextRunAtMs] as const));
}

export function publishDurableNextRunChanges(params: {
  state: CronServiceState;
  storeJobs: readonly CronJob[];
  stateOnly: boolean;
  suppressScheduledJobId?: string;
}) {
  const previous = params.state.durableNextRunAtMsByJobId;
  const next = params.stateOnly ? new Map(previous) : durableNextRunsFromJobs(params.storeJobs);

  if (params.stateOnly) {
    const currentJobsById = new Map(params.storeJobs.map((job) => [job.id, job] as const));
    // State-only writes cannot create or delete rows. Preserve durable topology
    // and update only rows that both snapshots know SQLite already contains.
    for (const jobId of previous.keys()) {
      const job = currentJobsById.get(jobId);
      if (job) {
        next.set(jobId, job.state.nextRunAtMs);
      }
    }
  }

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
  publishDurableNextRunChanges({ state, storeJobs: state.store.jobs, stateOnly: false });
}
