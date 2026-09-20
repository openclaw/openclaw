import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { materializeLegacyDefaultCronJobOwners } from "../legacy-default-agent-owner-migration.js";
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
import {
  proposeCronRunRecovery,
  recomputeUnownedCronSchedules,
  recoverCronRunProposal,
  type CronRunRecoveryProposal,
  type CronRunRecoveryResult,
} from "./run-recovery.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { InterruptedStartupRun } from "./startup-run-repair.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

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
    for (const receipt of listForeignReceipts(state)) {
      const job = state.store?.jobs.find((entry) => entry.id === receipt.jobId);
      const proposal: CronRunRecoveryProposal = {
        jobId: receipt.jobId,
        ...(job?.state.queuedAtMs !== undefined ? { queuedAtMs: job.state.queuedAtMs } : {}),
        ...(job?.state.runningAtMs !== undefined ? { runningAtMs: job.state.runningAtMs } : {}),
        runningReceiptId: job?.state.runningReceiptId,
        receipt,
      };
      schedulingChanged =
        applyRecoveryResult({
          state,
          proposal,
          result: recoverCronRunProposal(state, proposal),
          interruptedRuns,
        }) || schedulingChanged;
    }
    if (schedulingChanged) {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      for (const interrupted of interruptedRuns) {
        emitInterruptedCronRun(state, interrupted);
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
        await ensureLoaded(state, { skipRecompute: true });
        if (signal.aborted || state.stopped || state.lifecycleGeneration !== generation) {
          return { settled: false };
        }
        const job = state.store?.jobs.find((entry) => entry.id === jobId);
        const proposal = proposeCronRunRecovery(
          state,
          jobId,
          job?.state.queuedAtMs,
          job?.state.runningAtMs,
        );
        const recovery = recoverCronRunProposal(state, proposal);
        const interruptedRuns: InterruptedStartupRun[] = [];
        const changed = applyRecoveryResult({ state, proposal, result: recovery, interruptedRuns });
        if (changed) {
          await ensureLoaded(state, { forceReload: true, skipRecompute: true });
          for (const interrupted of interruptedRuns) {
            emitInterruptedCronRun(state, interrupted);
          }
          if (state.schedulerStarted) {
            armTimer(state);
          }
        }
        if (signal.aborted || state.stopped || state.lifecycleGeneration !== generation) {
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
  state.stopped = false;
  stopForeignReceiptMonitor(state);
  configureForeignReceiptMonitor(state, async () => await reconcileForeignRunReceipts(state));
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedRuns: InterruptedStartupRun[] = [];
  const skipJobIds = new Set<string>();
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    if (state.deps.legacyDefaultAgentId) {
      const rewritten = await materializeLegacyDefaultCronJobOwners({
        storePath: state.deps.storePath,
        legacyDefaultAgentId: state.deps.legacyDefaultAgentId,
      });
      if (rewritten > 0) {
        state.deps.log.info(
          { storePath: state.deps.storePath, rewritten },
          "cron: assigned legacy jobs to the retained owner",
        );
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      }
    }
    const proposals: CronRunRecoveryProposal[] = [];
    for (const job of state.store?.jobs ?? []) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        proposals.push(proposeCronRunRecovery(state, job.id, job.state.queuedAtMs, undefined));
      }
      if (typeof job.state.runningAtMs === "number") {
        proposals.push(proposeCronRunRecovery(state, job.id, undefined, job.state.runningAtMs));
      }
    }
    for (const proposal of proposals) {
      applyRecoveryResult({
        state,
        proposal,
        result: recoverCronRunProposal(state, proposal, "startup"),
        interruptedRuns,
        skipJobIds,
      });
    }
    if (proposals.length > 0) {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    }
    if (listForeignReceipts(state).length > 0) {
      const maintenance = recomputeUnownedCronSchedules(state);
      runPostPersistCronNotifications(state, maintenance.notifications);
      if (maintenance.changed) {
        applyCronRuntimeRowsToState(state, maintenance.jobs);
      }
    }
  });

  if (state.stopped) {
    return;
  }
  // Publish the interrupted attempt before catch-up can finish its successor.
  for (const interrupted of interruptedRuns) {
    emitInterruptedCronRun(state, interrupted);
  }
  await runMissedJobs(state, {
    skipJobIds: skipJobIds.size > 0 ? skipJobIds : undefined,
    deferAgentWork: true,
  });

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (state.stopped) {
      return;
    }
    if (listForeignReceipts(state).length === 0) {
      const maintenance = recomputeUnownedCronSchedules(state, { recomputeExpired: true });
      runPostPersistCronNotifications(state, maintenance.notifications);
      applyCronRuntimeRowsToState(state, maintenance.jobs);
    }
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
  });
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  state.lifecycleGeneration += 1;
  state.stopped = true;
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
