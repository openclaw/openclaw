import { locked } from "./locked.js";
import { stopCronRunQueue, drainCronRunQueue, waitForCronRunQueue } from "./run-queue.js";
import { recoverCronRuns } from "./run-recovery.js";
import { refreshCronScheduler, startCronScheduler, stopCronScheduler } from "./scheduler-actor.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

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
  const skipJobIds = await locked(state, async () => {
    await ensureLoaded(state);
    return await recoverCronRuns(state);
  });
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  await startCronScheduler(state, skipJobIds);
  if (state.stopped || state.lifecycleGeneration !== generation) {
    await stopCronScheduler(state);
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
    void drainCronRunQueue(state);
  }
}
