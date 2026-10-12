import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { retainGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { createAbortError, isAbortError } from "../../infra/abort-signal.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import { captureCronRunAdmissionTracker } from "../mutation-completion.js";
import {
  CronRunReceiptRevisionError,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptSettlementDisposition,
} from "../store/run-receipt-store.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { locked } from "./locked.js";
import { waitForRunSettlement } from "./ops-lifecycle.js";
import {
  activatePreparedManualRun,
  inspectManualRunDisposition,
  prepareManualRun,
  releasePreparedManualReservationAfterReloadWithRetry,
  releasePreparedManualReservationWithRetry,
  type ActivatedManualRun,
  type ManualRunOptions,
  type OnExitRunOptions,
  type PreparedManualRun,
} from "./ops-run-preparation.js";
import { clearManualCronJobActive } from "./ops-shared.js";
import { releaseQueuedCronRun, runWithCronAdmission } from "./run-admission.js";
import { createCronOwnerExecutionIdentityAdmission } from "./run-history.js";
import type { CronRunMode, CronServiceState, CronWakeMode } from "./state.js";
import { isImmediateCronRunMode } from "./state.js";
import { emitCronRunFinished, type ManualRunTerminalTracker } from "./timer-outcome-events.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { armTimer, authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer.js";
import { wake } from "./wake.js";

let nextManualRunId = 1;

async function finishPreparedManualRun(
  state: CronServiceState,
  prepared: ActivatedManualRun,
  mode?: CronRunMode,
): Promise<void> {
  const executionJob = prepared.executionJob;
  const startedAt = prepared.startedAt;
  const jobId = prepared.jobId;
  const taskRunId = prepared.taskRunId;
  let finalizationStarted = false;
  let receiptSettlementDisposition: CronRunReceiptSettlementDisposition | undefined;

  try {
    let coreResult: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
    try {
      coreResult = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker: prepared.activeJobMarker,
        owningCronLaneTaskMarker: prepared.owningCronLaneTaskMarker,
        streamBatch: prepared.streamBatch,
        streamScheduleKey: prepared.streamScheduleKey,
        streamSourceIdentity: prepared.streamSourceIdentity,
        runReceipt: prepared.runReceipt,
        runReceiptContext: prepared.runReceiptContext,
        executionIdentity: createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: prepared.runReceipt,
        }),
      });
    } catch (err) {
      if (err instanceof CronRunReceiptRevisionError && err.reason === "owner-unavailable") {
        receiptSettlementDisposition = "owner-unavailable";
      }
      coreResult = authorCronRunCompletion(executionJob, {
        status: "error",
        error:
          err instanceof CronRunReceiptRevisionError ? err.message : normalizeCronRunErrorText(err),
      });
    }
    if (prepared.onTriggerDisposition) {
      const disposition = coreResult.triggerEval?.busy
        ? "busy"
        : coreResult.status === "error"
          ? "error"
          : coreResult.status !== "ok"
            ? "dropped"
            : !executionJob.trigger
              ? "fired"
              : coreResult.triggerEval?.fired
                ? "fired"
                : "dropped";
      prepared.onTriggerDisposition(disposition);
    }
    finalizationStarted = true;
    await finalizeCompletedCronRunOutcomes(
      state,
      [
        {
          ...coreResult,
          jobId,
          job: prepared.admittedJob,
          taskRunId,
          activeJobMarker: prepared.activeJobMarker,
          reservationIdentity: prepared.reservationIdentity,
          runReceipt: prepared.runReceipt,
          runReceiptContext: prepared.runReceiptContext,
          receiptSettlementDisposition,
          startedAt,
          endedAt: state.deps.nowMs(),
          request: {
            executionJob,
            preserveCadence: isImmediateCronRunMode(mode),
            scheduleOwnershipAtMs: prepared.scheduleOwnershipAtMs,
            runId: prepared.runId,
            terminalTracker: prepared.terminalTracker,
          },
        },
      ],
      { onRequestedRunFinalized: () => armTimer(state) },
    );
  } finally {
    if (!finalizationStarted) {
      // Callback failures can leave execution before the finalizer takes ownership.
      releaseLocalCronRunReceiptOwnership(prepared.runReceipt);
      try {
        releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
      } finally {
        clearManualCronJobActive(state, jobId, prepared.activeJobMarker);
      }
    }
  }
}

/** Runs a cron job manually, reserving it under lock before executing outside the lock. */
export async function run(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: ManualRunOptions,
) {
  const execute = async () => {
    const prepared = await prepareManualRun(state, id, mode, opts);
    if (!prepared.ok || !prepared.ran) {
      return prepared;
    }
    return await executePreparedManualRun(state, prepared, mode);
  };
  return await (opts?.streamBatch !== undefined && state.deps.runSchedulerOwned
    ? state.deps.runSchedulerOwned(execute)
    : execute());
}

/** Consumes an observed exit only when its payload owns the durable reservation. */
export async function runOnExit(state: CronServiceState, id: string, opts: OnExitRunOptions) {
  const generation = state.lifecycleGeneration;
  const execute = async () => {
    const commitGuard = () => {
      if (opts.signal.aborted || state.stopped || generation !== state.lifecycleGeneration) {
        throw createAbortError("cron on-exit admission cancelled");
      }
      opts.commitGuard();
    };
    try {
      while (await waitForRunSettlement(state, id, opts.signal)) {
        commitGuard();
        const prepared = await prepareManualRun(state, id, "force", {
          onExit: { ...opts, commitGuard },
          commitGuard,
        });
        if (!prepared.ok || !prepared.ran) {
          if (prepared.ok && prepared.reason === "already-running") {
            // Another caller won the receipt after our wait. The exit is still
            // unconsumed, so follow that receipt before attempting admission again.
            continue;
          }
          return prepared;
        }
        return await executePreparedManualRun(state, prepared, "force");
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }
    }
    return { ok: true, ran: false, reason: "stopped" } as const;
  };
  return await (state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(execute) : execute());
}

async function executePreparedManualRun(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
  mode?: CronRunMode,
  onActivationSettled?: () => void,
) {
  const admission = await runWithCronAdmission(
    state,
    async () => {
      let activeRun: Awaited<ReturnType<typeof activatePreparedManualRun>>;
      try {
        activeRun = await activatePreparedManualRun(state, prepared, mode);
      } catch (error) {
        // Activation failures still own the original durable reservation. Once
        // activation succeeds, finishPreparedManualRun releases it after execution.
        try {
          await locked(state, async () => {
            await releasePreparedManualReservationWithRetry(state, prepared);
          });
        } catch (cleanupError) {
          state.deps.log.warn(
            { jobId: prepared.jobId, err: String(cleanupError) },
            "cron: failed to release manual run reservation after activation error",
          );
        }
        throw error;
      } finally {
        // Activation owns the last caller-authorized write. The scheduled run
        // owns execution afterward, so do not join its payload to the caller.
        onActivationSettled?.();
      }
      if (!activeRun.ran) {
        return activeRun;
      }
      // Admission is complete; the stored job now owns execution, not the
      // operator request whose tool and source scopes can close before its next tool call.
      const execute = () => finishPreparedManualRun(state, activeRun, mode);
      await runOutsideOperatorToolGatewayAuthority(() =>
        state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(execute) : execute(),
      );
      return { ok: true, ran: true } as const;
    },
    undefined,
    prepared.onExit?.signal,
  );
  if (admission.kind === "stopped") {
    await releasePreparedManualReservationAfterReloadWithRetry(state, prepared);
    return { ok: true, ran: false, reason: "stopped" } as const;
  }
  return admission.value;
}

/** Acknowledges queued manual work only after its durable reservation exists. */
export async function enqueueRun(
  state: CronServiceState,
  id: string,
  mode?: CronRunMode,
  opts?: { commitGuard?: () => void },
) {
  const disposition = await inspectManualRunDisposition(state, id, mode, opts);
  if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) {
    return disposition;
  }

  const scheduleOwnershipAtMs = state.deps.nowMs();
  const runId = `manual:${id}:${scheduleOwnershipAtMs}:${nextManualRunId++}`;
  const terminalTracker: ManualRunTerminalTracker = { emitted: false };
  const releaseCallerAuthority = retainGatewayDeviceRevocation(opts?.commitGuard);
  const acceptance = createDeferredCore<
    { ok: true; enqueued: true; runId: string } | Exclude<PreparedManualRun, { ran: true }>
  >();
  const trackCallerWork = captureCronRunAdmissionTracker();
  const activationSettled = createDeferredCore();
  let accepted = false;
  const acceptQueue = () => {
    if (!accepted && trackCallerWork) {
      // Retain the existing caller resources after the durable reservation and
      // before acknowledging it. Genuine aborts and all commit guards stay live.
      void trackCallerWork(() => activationSettled.promise).catch((error: unknown) => {
        state.deps.log.error(
          { jobId: id, runId, err: String(error) },
          "cron: queued manual admission tracking failed",
        );
      });
    }
    accepted = true;
    acceptance.resolve({ ok: true, enqueued: true, runId });
  };
  let queuedRun: Promise<unknown>;
  try {
    // The run outlives the calling agent turn, so it must not write through that turn's transcript lifecycle.
    queuedRun = runWithoutOwnedSessionTranscriptWrites(() =>
      runWithGatewayIndependentRootWorkContinuation(async () => {
        opts?.commitGuard?.();
        const prepared = await prepareManualRun(state, id, mode, {
          runId,
          scheduleOwnershipAtMs,
          terminalTracker,
          commitGuard: opts?.commitGuard,
        });
        if (!prepared.ok || !prepared.ran) {
          acceptance.resolve(prepared);
          return prepared;
        }
        let dispatched = false;
        try {
          opts?.commitGuard?.();
          return await enqueueCommandInLane(
            CommandLane.Cron,
            async (owningCronLaneTaskMarker) => {
              acceptQueue();
              dispatched = true;
              const result = await executePreparedManualRun(
                state,
                { ...prepared, owningCronLaneTaskMarker },
                mode,
                activationSettled.resolve,
              );
              if (result.ok && "ran" in result && !result.ran) {
                if (result.reason !== "invalid-spec" && result.reason !== "ownerless") {
                  const finishedAt = state.deps.nowMs();
                  const job = state.store?.jobs.find((entry) => entry.id === id);
                  await emitCronRunFinished(
                    state,
                    {
                      jobId: id,
                      action: "finished",
                      job,
                      status: "skipped",
                      error: `queued manual run skipped before execution: ${result.reason}`,
                      runId,
                      runAtMs: finishedAt,
                      durationMs: 0,
                      nextRunAtMs: job?.state.nextRunAtMs,
                    },
                    terminalTracker,
                  );
                }
                state.deps.log.info(
                  { jobId: id, runId, reason: result.reason },
                  "cron: queued manual run skipped before execution",
                );
              }
              return result;
            },
            {
              onQueued: acceptQueue,
              taskIdentity: { taskKind: "cron", runId },
              warnAfterMs: 5_000,
              onWait: (waitMs, queuedAhead) => {
                state.deps.log.warn(
                  { jobId: id, runId, waitMs, queuedAhead },
                  "cron: queued manual run waiting for an execution slot",
                );
              },
            },
          );
        } finally {
          if (!dispatched) {
            try {
              await releasePreparedManualReservationAfterReloadWithRetry(state, prepared);
            } catch (cleanupError) {
              state.deps.log.warn(
                { jobId: id, err: String(cleanupError) },
                "cron: failed to release manual reservation after queue rejection",
              );
            }
          }
        }
      }, "cron:manual-run"),
    );
  } catch (error) {
    activationSettled.resolve();
    releaseCallerAuthority?.();
    throw error;
  }
  const settled = queuedRun
    .catch(async (err: unknown) => {
      if (!accepted) {
        acceptance.reject(err);
        return;
      }
      if (terminalTracker.emitted) {
        state.deps.log.error(
          { jobId: id, runId, err: String(err) },
          "cron: queued manual run failed after emitting its terminal event",
        );
        return;
      }
      const finishedAt = state.deps.nowMs();
      const job = state.store?.jobs.find((entry) => entry.id === id);
      await emitCronRunFinished(
        state,
        {
          jobId: id,
          action: "finished",
          job,
          status: "error",
          error: normalizeCronRunErrorText(err),
          runId,
          runAtMs: finishedAt,
          durationMs: 0,
          nextRunAtMs: job?.state.nextRunAtMs,
        },
        terminalTracker,
      );
      state.deps.log.error(
        { jobId: id, runId, err: String(err) },
        "cron: queued manual run background execution failed",
      );
    })
    .finally(() => {
      // Covers queue clearing, stopped admission, preparation failure, and any
      // path that never entered the activation callback.
      activationSettled.resolve();
      releaseCallerAuthority?.();
      state.queuedManualRuns.delete(runId);
    });
  state.queuedManualRuns.set(runId, settled);
  return await acceptance.promise;
}

/**
 * Resolves true once an accepted manual run has written its terminal history row,
 * or false when the timeout or caller signal ends the wait first.
 */
export async function waitForManualRun(
  state: CronServiceState,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const settled = state.queuedManualRuns.get(runId);
  if (!settled) {
    return true;
  }
  if (signal?.aborted) {
    return false;
  }
  const { promise, resolve } = createDeferredCore<boolean>();
  const timer = setSafeTimeout(() => resolve(false), timeoutMs);
  const onAbort = () => resolve(false);
  signal?.addEventListener("abort", onAbort, { once: true });
  // Background failures are logged by the run owner; the waiter only needs settlement.
  settled.then(
    () => resolve(true),
    () => resolve(true),
  );
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Enqueues manual wake text through the cron wake API. */
export function wakeNow(
  state: CronServiceState,
  opts: {
    mode: CronWakeMode;
    text: string;
    sessionKey?: string;
    agentId?: string;
    commitGuard?: () => void;
  },
) {
  return wake(state, opts);
}
