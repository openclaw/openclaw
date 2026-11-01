import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { subscribeCronJobsStoreMutations } from "../store.js";
import { locked } from "./locked.js";
import { stopCronRunQueue, drainCronRunQueue, waitForCronRunQueue } from "./run-queue.js";
import { recoverCronRuns } from "./run-recovery.js";
import { refreshCronScheduler, startCronScheduler, stopCronScheduler } from "./scheduler-actor.js";
import { emit, type CronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const mutationSubscriptions = new WeakMap<CronServiceState, () => void>();

/** Adopt published rows; the worker alone recomputes schedules after this lock releases. */
export async function reloadProvisionedCronJobs(
  state: CronServiceState,
  generation = state.lifecycleGeneration,
  previousIds = new Set(state.store?.jobs.map((job) => job.id)),
): Promise<void> {
  if (state.stopped || state.lifecycleGeneration !== generation || !state.schedulerStarted) {
    return;
  }
  await ensureLoaded(state);
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  refreshCronScheduler(state);
  for (const job of state.store?.jobs ?? []) {
    if (!previousIds.has(job.id)) {
      emit(state, { jobId: job.id, action: "added", job, nextRunAtMs: job.state.nextRunAtMs });
    }
  }
}

function subscribeStoreMutations(state: CronServiceState): void {
  mutationSubscriptions.get(state)?.();
  const generation = state.lifecycleGeneration;
  mutationSubscriptions.set(
    state,
    subscribeCronJobsStoreMutations(state.deps.storeKey, () => {
      const refresh = async () => {
        await locked(state, () => reloadProvisionedCronJobs(state, generation));
        if (!state.stopped && state.lifecycleGeneration === generation && state.schedulerStarted) {
          await state.deps.onProvisionedJobsReloaded?.();
        }
      };
      const work = runInDetachedAsyncContext(() =>
        state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(refresh) : refresh(),
      ).catch((error: unknown) => {
        state.deps.log.warn({ err: String(error) }, "cron: failed to adopt provisioned jobs");
      });
      state.schedulerDrain = Promise.all([state.schedulerDrain, work]).then(() => undefined);
    }),
  );
}

/** Recover committed state before the worker starts dispatching new requests. */
export async function start(state: CronServiceState): Promise<void> {
  if (state.schedulerStarted) {
    return;
  }
  const generation = state.lifecycleGeneration;
  await state.schedulerDrain;
  if (state.lifecycleGeneration !== generation) {
    return;
  }
  if (state.schedulerScope.signal.aborted) {
    state.schedulerScope = state.deps.scheduler.scope();
  }
  state.stopped = false;
  const startupJobIds = new Set<string>();
  const skipJobIds = await locked(state, async () => {
    await ensureLoaded(state);
    const recovered = await recoverCronRuns(state);
    for (const job of state.store?.jobs ?? []) {
      startupJobIds.add(job.id);
    }
    return recovered;
  });
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  await startCronScheduler(state, skipJobIds);
  if (state.stopped || state.lifecycleGeneration !== generation) {
    await stopCronScheduler(state);
    return;
  }
  subscribeStoreMutations(state);
  // Startup requests can await execution while provisioning publishes new jobs.
  await locked(state, () => reloadProvisionedCronJobs(state, generation, startupJobIds));
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  await state.deps.onProvisionedJobsReloaded?.();
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  state.deps.log.info(
    { enabled: state.deps.cronEnabled, jobs: state.store?.jobs.length ?? 0 },
    "cron: started",
  );
}

/** Close dispatch synchronously, then join execution and the retained worker lease. */
export function stop(state: CronServiceState) {
  state.lifecycleGeneration += 1;
  state.stopped = true;
  mutationSubscriptions.get(state)?.();
  mutationSubscriptions.delete(state);
  state.schedulerStarted = false;
  state.schedulerDrain = Promise.allSettled([
    state.schedulerDrain,
    stopCronScheduler(state),
    stopCronRunQueue(state),
    waitForCronRunQueue(state),
    state.schedulerScope.stop(),
  ]).then((outcomes) => {
    const errors = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => String(outcome.reason));
    if (errors.length > 0) {
      state.deps.log.warn({ errors }, "cron: shutdown left work for recovery");
    }
  });
}

export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  refreshCronScheduler(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (state.schedulerStarted) {
    refreshCronScheduler(state);
    void drainCronRunQueue(state).catch((error: unknown) =>
      state.deps.log.warn({ err: String(error) }, "cron: queue drain delayed"),
    );
  }
}
