import { captureCronJobConfigRevision } from "../config-revision.js";
import type { CronJob } from "../types.js";
import { emit, emitCronDefinitionChanges, type CronServiceState } from "./state.js";

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
  if (jobsById.size === 0 && deleted.size === 0) {
    if (opts?.publish !== false) {
      publishDurableNextRunChanges({ state, storeJobs: state.store.jobs });
    }
    return;
  }
  const configRevisions = new Map(state.jobConfigRevisions);
  const previousJobs: CronJob[] = [];
  const nextJobs: CronJob[] = [];
  const retainedJobs: CronJob[] = [];
  for (const previous of state.store.jobs) {
    const id = previous.id;
    const next = jobsById.get(id);
    if (next || deleted.has(id)) {
      previousJobs.push(previous);
    }
    if (!deleted.has(id)) {
      retainedJobs.push(next ?? previous);
      if (next) {
        nextJobs.push(next);
      }
    }
    jobsById.delete(id);
  }
  for (const job of jobsById.values()) {
    if (!deleted.has(job.id)) {
      retainedJobs.push(job);
      nextJobs.push(job);
    }
  }
  if (state.deps.onDefinitionChange) {
    for (const job of nextJobs) {
      configRevisions.set(job.id, captureCronJobConfigRevision(job));
    }
  }
  for (const jobId of deleted) {
    configRevisions.delete(jobId);
  }
  state.store.jobs = retainedJobs;
  // Unchanged resident rows keep their identity and cannot change their definition.
  emitCronDefinitionChanges(state, previousJobs, nextJobs, configRevisions);
  if (opts?.publish !== false) {
    publishDurableNextRunChanges({ state, storeJobs: state.store.jobs });
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
