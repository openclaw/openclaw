import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { SqliteWorkerAdmissionTimeoutError } from "../../infra/sqlite-worker-contract.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { subscribeCronJobsStoreMutations } from "../store.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import type { CronRunRecoveryResult, InterruptedStartupRun } from "../store/run-recovery.types.js";
import {
  configureForeignReceiptMonitor,
  enrollForeignReceipt,
  listForeignReceipts,
  removeForeignReceipt,
  resumeForeignReceiptMonitor,
  stopForeignReceiptMonitor,
  waitForForeignReceipt,
} from "./foreign-receipt-monitor.js";
import { nextWakeAtMs } from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { cancelCronRunAdmissionWaiters } from "./run-admission.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { emit, type CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import { MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

const mutationSubscriptions = new WeakMap<CronServiceState, () => void>();

function stopStoreMutationSubscription(state: CronServiceState): void {
  mutationSubscriptions.get(state)?.();
  mutationSubscriptions.delete(state);
}

/** Adopts a committed lifecycle change while the caller holds the cron operation lock. */
export async function reloadProvisionedCronJobs(
  state: CronServiceState,
  generation = state.lifecycleGeneration,
): Promise<void> {
  const isCurrent = () => !state.stopped && state.lifecycleGeneration === generation;
  // Startup's final reload adopts publications received before scheduling is ready.
  if (!isCurrent() || !state.schedulerStarted) {
    return;
  }
  const previousIds = new Set(state.store?.jobs.map((job) => job.id));
  await ensureLoaded(state, { forceReload: true });
  if (!isCurrent()) {
    return;
  }
  await recomputeUnownedCronSchedules(state);
  if (!isCurrent()) {
    return;
  }
  armTimer(state);
  for (const job of state.store?.jobs ?? []) {
    if (!previousIds.has(job.id)) {
      emit(state, {
        jobId: job.id,
        action: "added",
        job,
        nextRunAtMs: job.state.nextRunAtMs,
      });
    }
  }
}

function subscribeStoreMutations(state: CronServiceState): void {
  const generation = state.lifecycleGeneration;
  mutationSubscriptions.set(
    state,
    subscribeCronJobsStoreMutations(state.deps.storePath, () => {
      const refresh = async () => {
        await locked(state, async () => await reloadProvisionedCronJobs(state, generation));
        if (state.stopped || state.lifecycleGeneration !== generation || !state.schedulerStarted) {
          return;
        }
        // Reconciliation reads the service again; retain its work after releasing the lock.
        await state.deps.onProvisionedJobsReloaded?.();
      };
      const reportFailure = (err: unknown) => {
        state.deps.log.warn({ err: String(err) }, "cron: failed to adopt provisioned jobs");
      };
      try {
        const work = runInDetachedAsyncContext(() =>
          state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(refresh) : refresh(),
        ).catch(reportFailure);
        // stop() closes future publications; accepted worker work still owns its settlement.
        state.schedulerDrain = Promise.all([state.schedulerDrain, work]).then(() => undefined);
      } catch (err) {
        reportFailure(err);
      }
    }),
  );
}

function applyRecoveryResult(params: {
  state: CronServiceState;
  proposal: CronRunRecoveryProposal;
  result: CronRunRecoveryResult;
  interruptedRuns: InterruptedStartupRun[];
  skipJobIds?: Set<string>;
}): boolean {
  const { state, proposal, result } = params;
  if (result.kind === "live") {
    enrollForeignReceipt(state, result.receipt);
    params.skipJobIds?.add(proposal.jobId);
    return false;
  }
  if (result.kind === "superseded") {
    if (result.receipt) {
      enrollForeignReceipt(state, result.receipt);
      params.skipJobIds?.add(proposal.jobId);
    } else {
      removeForeignReceipt(state, proposal.jobId);
    }
    return true;
  }
  removeForeignReceipt(state, proposal.jobId);
  runPostPersistCronNotifications(state, result.notifications);
  if (result.interrupted) {
    params.interruptedRuns.push(result.interrupted);
  }
  if (result.skipStartupCatchup) {
    params.skipJobIds?.add(proposal.jobId);
  }
  return true;
}

async function reconcileForeignRunReceipts(state: CronServiceState): Promise<void> {
  let schedulingChanged = false;
  const interruptedRuns: InterruptedStartupRun[] = [];
  await locked(state, async () => {
    if (state.stopped) {
      return;
    }
    const proposals = listForeignReceipts(state).map((receipt): CronRunRecoveryProposal => {
      const job = state.store?.jobs.find((entry) => entry.id === receipt.jobId);
      return {
        jobId: receipt.jobId,
        queuedAtMs: job?.state.queuedAtMs,
        runningAtMs: job?.state.runningAtMs,
        runningReceiptId: job?.state.runningReceiptId,
        receipt,
      };
    });
    try {
      await recoverCronRunProposals(state, proposals, {
        onRecovery(proposal, result) {
          schedulingChanged =
            applyRecoveryResult({ state, proposal, result, interruptedRuns }) || schedulingChanged;
        },
      });
    } finally {
      if (schedulingChanged) {
        await ensureLoaded(state, { forceReload: true });
        for (const interrupted of interruptedRuns) {
          await emitInterruptedCronRun(state, interrupted);
        }
      }
    }
  });
  if (schedulingChanged && state.schedulerStarted) {
    armTimer(state);
  }
}

/** Waits for receipt retirement without reserving a run or extending its timeout response. */
export async function waitForRunSettlement(
  state: CronServiceState,
  jobId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const generation = state.lifecycleGeneration;
  while (true) {
    const result = await racePromiseWithAbortSignal(
      locked(state, async (): Promise<{ settled: boolean } | { waiting: Promise<boolean> }> => {
        if (signal.aborted || state.stopped || state.lifecycleGeneration !== generation) {
          return { settled: false };
        }
        await ensureLoaded(state);
        if (signal.aborted || state.stopped || state.lifecycleGeneration !== generation) {
          return { settled: false };
        }
        const job = state.store?.jobs.find((entry) => entry.id === jobId);
        const proposal: CronRunRecoveryProposal = {
          jobId,
          queuedAtMs: job?.state.queuedAtMs,
          runningAtMs: job?.state.runningAtMs,
        };
        let recovery: CronRunRecoveryResult | undefined;
        let changed = false;
        const interruptedRuns: InterruptedStartupRun[] = [];
        try {
          await recoverCronRunProposals(state, [proposal], {
            signal,
            onRecovery(observed, recovered) {
              recovery = recovered;
              changed = applyRecoveryResult({
                state,
                proposal: observed,
                result: recovered,
                interruptedRuns,
              });
            },
          });
        } finally {
          if (changed) {
            await ensureLoaded(state, { forceReload: true });
            for (const interrupted of interruptedRuns) {
              await emitInterruptedCronRun(state, interrupted);
            }
            if (state.schedulerStarted) {
              armTimer(state);
            }
          }
        }
        if (
          !recovery ||
          signal.aborted ||
          state.stopped ||
          state.lifecycleGeneration !== generation
        ) {
          return { settled: false };
        }
        if (recovery.kind === "repaired" || !recovery.receipt) {
          return { settled: true };
        }
        configureForeignReceiptMonitor(state, async () => await reconcileForeignRunReceipts(state));
        return { waiting: waitForForeignReceipt(state, jobId, signal) };
      }),
      signal,
    ).catch((error: unknown) => {
      if (signal.aborted && isAbortError(error)) {
        return { settled: false };
      }
      throw error;
    });
    if ("settled" in result) {
      return result.settled;
    }
    if (!(await result.waiting)) {
      return false;
    }
  }
}

/** Starts the cron service, atomically repairs abandoned runs, and arms scheduling. */
export async function start(state: CronServiceState): Promise<void> {
  const generation = state.lifecycleGeneration;
  try {
    await startOnce(state);
  } catch (error) {
    if (!(error instanceof SqliteWorkerAdmissionTimeoutError)) {
      throw error;
    }
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    state.deps.log.warn({ err: String(error) }, "cron: startup admission delayed; retrying later");
    stopTimer(state);
    // Recovery must retain startup semantics for interrupted one-shots until it completes.
    const retry = {};
    state.startupCatchup = retry;
    const scheduler = state.schedulerScope;
    scheduler.schedule({
      id: `cron:${state.deps.storePath}:startup`,
      delayMs: MIN_REFIRE_GAP_MS,
      run: async () => {
        if (
          state.stopped ||
          state.lifecycleGeneration !== generation ||
          state.startupCatchup !== retry
        ) {
          return;
        }
        await runInDetachedAsyncContext(async () => {
          let admission;
          try {
            admission = await beginGatewayRootWorkAdmissionWhenOpen(
              "cron:startup-retry",
              scheduler.signal,
            );
          } catch (admissionError) {
            if (
              admissionError instanceof GatewayDrainingError ||
              (scheduler.signal.aborted && isAbortError(admissionError))
            ) {
              return;
            }
            throw admissionError;
          }
          try {
            if (
              state.stopped ||
              state.lifecycleGeneration !== generation ||
              state.startupCatchup !== retry
            ) {
              return;
            }
            state.startupCatchup = undefined;
            const resume = () => start(state);
            await admission.run(() =>
              state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(resume) : resume(),
            );
          } finally {
            admission.release();
          }
        });
      },
    });
  }
}

async function startOnce(state: CronServiceState): Promise<void> {
  stopStoreMutationSubscription(state);
  if (state.schedulerScope.signal.aborted) {
    state.schedulerScope = state.deps.scheduler.scope();
  }
  state.stopped = false;
  const generation = state.lifecycleGeneration;
  stopForeignReceiptMonitor(state);
  configureForeignReceiptMonitor(state, async () => await reconcileForeignRunReceipts(state));
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }
  subscribeStoreMutations(state);
  const failedStart = (error: unknown): never => {
    if (!state.schedulerStarted && state.lifecycleGeneration === generation) {
      stopStoreMutationSubscription(state);
    }
    throw error;
  };

  const skipJobIds = new Set<string>();
  await locked(state, async () => {
    const interruptedRuns: InterruptedStartupRun[] = [];
    await ensureLoaded(state);
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    const proposals: CronRunRecoveryProposal[] = [];
    for (const job of state.store?.jobs ?? []) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        proposals.push({ jobId: job.id, queuedAtMs: job.state.queuedAtMs });
      }
      if (typeof job.state.runningAtMs === "number") {
        proposals.push({ jobId: job.id, runningAtMs: job.state.runningAtMs });
      }
    }
    try {
      await recoverCronRunProposals(state, proposals, {
        mode: "startup",
        onRecovery(proposal, result) {
          applyRecoveryResult({ state, proposal, result, interruptedRuns, skipJobIds });
        },
      });
    } finally {
      if (proposals.length > 0) {
        await ensureLoaded(state, { forceReload: true });
      }
      // Publish committed interruptions before a replacement can start catch-up.
      for (const interrupted of interruptedRuns) {
        await emitInterruptedCronRun(state, interrupted);
      }
    }
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    if (listForeignReceipts(state).length > 0) {
      await recomputeUnownedCronSchedules(state);
    }
  }).catch(failedStart);

  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  try {
    await runMissedJobs(state, {
      skipJobIds: skipJobIds.size > 0 ? skipJobIds : undefined,
      deferAgentWork: true,
    });
  } catch (err) {
    if (err instanceof SqliteWorkerAdmissionTimeoutError) {
      throw err;
    }
    // Catch-up releases its timer fence even when a terminal write fails.
    // Keep future jobs live without hiding that failure from the caller.
    if (!state.stopped && state.lifecycleGeneration === generation) {
      state.schedulerStarted = true;
      try {
        armTimer(state);
        resumeForeignReceiptMonitor(state);
      } catch (armError) {
        state.deps.log.warn(
          { err: String(armError) },
          "cron: failed to arm scheduling after startup catch-up failed",
        );
      }
    }
    throw err;
  }

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true });
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    if (listForeignReceipts(state).length === 0) {
      await recomputeUnownedCronSchedules(state, { recomputeExpired: true });
    }
    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    state.schedulerStarted = true;
    armTimer(state);
    resumeForeignReceiptMonitor(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  }).catch(failedStart);
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  // One close owns its teardown; repeated drain calls must not revoke that work.
  if (!state.stopped) {
    state.lifecycleGeneration += 1;
  }
  state.stopped = true;
  stopStoreMutationSubscription(state);
  // stop() closes admission synchronously; only external drain callers join it.
  state.schedulerDrain = Promise.all([state.schedulerDrain, state.schedulerScope.stop()]).then(
    () => undefined,
  );
  cancelCronRunAdmissionWaiters(state);
  state.schedulerStarted = false;
  stopForeignReceiptMonitor(state);
  stopTimer(state);
}

/** Temporarily stops automatic ticks without running startup recovery on resume. */
export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  // Exact already-enrolled receipts must still settle behind a suspension fence;
  // armTimer independently keeps unrelated scheduled work paused.
  stopTimer(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (!state.schedulerStarted) {
    return;
  }
  try {
    armTimer(state);
    resumeForeignReceiptMonitor(state);
  } catch (err) {
    state.schedulingPaused = true;
    stopTimer(state);
    throw err;
  }
}
