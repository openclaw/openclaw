import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
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
import { locked } from "./locked.js";
import { stopCronRunQueue, drainCronRunQueue, waitForCronRunQueue } from "./run-queue.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { refreshCronScheduler, startCronScheduler, stopCronScheduler } from "./scheduler-actor.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";

async function applyRecoveryResult(params: {
  state: CronServiceState;
  proposal: CronRunRecoveryProposal;
  result: CronRunRecoveryResult;
  interruptedRuns: InterruptedStartupRun[];
  skipJobIds?: Set<string>;
}): Promise<boolean> {
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
  await runPostPersistCronNotifications(state, result.notifications);
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
        async onRecovery(proposal, result) {
          schedulingChanged =
            (await applyRecoveryResult({ state, proposal, result, interruptedRuns })) ||
            schedulingChanged;
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
    refreshCronScheduler(state);
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
            async onRecovery(observed, recovered) {
              recovery = recovered;
              changed = await applyRecoveryResult({
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
              refreshCronScheduler(state);
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

/** Repairs interrupted runs before the worker takes sole scheduling ownership. */
export async function start(state: CronServiceState): Promise<void> {
  if (state.schedulerScope.signal.aborted) {
    state.schedulerScope = state.deps.scheduler.scope();
  }
  state.stopped = false;
  const generation = state.lifecycleGeneration;
  stopForeignReceiptMonitor(state);
  configureForeignReceiptMonitor(state, async () => await reconcileForeignRunReceipts(state));
  const skipJobIds = new Set<string>();
  await locked(state, async () => {
    await ensureLoaded(state);
    const interruptedRuns: InterruptedStartupRun[] = [];
    const proposals = (state.store?.jobs ?? []).map((job) => ({
      jobId: job.id,
      queuedAtMs: job.state.queuedAtMs,
      runningAtMs: job.state.runningAtMs,
    }));
    try {
      await recoverCronRunProposals(state, proposals, {
        mode: "startup",
        async onRecovery(proposal, result) {
          await applyRecoveryResult({ state, proposal, result, interruptedRuns, skipJobIds });
        },
      });
    } finally {
      await ensureLoaded(state, { forceReload: true });
      for (const interrupted of interruptedRuns) {
        await emitInterruptedCronRun(state, interrupted);
      }
    }
  });
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  await startCronScheduler(state, skipJobIds);
  if (state.stopped || state.lifecycleGeneration !== generation) {
    await stopCronScheduler(state);
    return;
  }
  resumeForeignReceiptMonitor(state);
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
  stopForeignReceiptMonitor(state);
  const stopping = Promise.all([
    stopCronScheduler(state),
    stopCronRunQueue(state),
    waitForCronRunQueue(state),
    state.schedulerScope.stop(),
  ]).then(() => undefined);
  state.schedulerDrain = Promise.all([state.schedulerDrain, stopping]).then(() => undefined);
  void state.schedulerDrain.catch((error: unknown) => {
    state.deps.log.warn({ err: String(error) }, "cron: shutdown left work for recovery");
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
    resumeForeignReceiptMonitor(state);
    void drainCronRunQueue(state);
  }
}
