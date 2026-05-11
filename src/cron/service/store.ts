import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

function invalidateStaleNextRunOnScheduleChange(params: {
  previousJobsById: ReadonlyMap<string, CronJob>;
  hydrated: CronJob;
}) {
  const previousJob = params.previousJobsById.get(params.hydrated.id);
  if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) {
    return;
  }
  params.hydrated.state ??= {};
  params.hydrated.state.nextRunAtMs = undefined;
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  const previousJobsById = new Map<string, CronJob>();
  for (const job of state.store?.jobs ?? []) {
    previousJobsById.set(job.id, job);
  }
  const loaded = await loadCronStore(state.deps.storeKey);
  const jobs = loaded.jobs ?? [];
  for (const hydrated of jobs) {
    invalidateStaleNextRunOnScheduleChange({ previousJobsById, hydrated });
  }
  state.store = {
    version: 1,
    jobs,
  };
  state.storeLoadedAtMs = state.deps.nowMs();

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storeKey: state.deps.storeKey },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(
  state: CronServiceState,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storeKey, state.store, opts);
}
