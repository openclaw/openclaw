import { retainGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { createAbortError, isAbortError } from "../../infra/abort-signal.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { captureCronRunAdmissionTracker } from "../mutation-completion.js";
import {
  CronRunReceiptRevisionError,
  finishCronRunReceipt,
  releaseLocalCronRunReceiptOwnership,
  type CronRunReceiptSettlementDisposition,
} from "../store/run-receipt-store.js";
import { isCronRunTriggerStateRetiredInDatabase } from "../store/run-receipt-trigger-state.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { locked } from "./locked.js";
import { waitForRunSettlement } from "./ops-lifecycle.js";
import {
  activatePreparedManualRun,
  type ActivatedManualRun,
  emitCronRunFinished,
  inspectManualRunDisposition,
  type ManualRunOptions,
  type ManualRunTerminalTracker,
  type OnExitRunOptions,
  type PreparedManualRun,
  prepareManualRun,
  releasePreparedManualReservationAfterReloadWithRetry,
  releasePreparedManualReservationWithRetry,
} from "./ops-run-preparation.js";
import { clearManualCronJobActive, maybeNotifyManualIsolatedSetupTimeout } from "./ops-shared.js";
import {
  releaseQueuedCronRun,
  runWithCronAdmission,
  supersedeActivatedCronRun,
} from "./run-admission.js";
import { cronRunReceiptPersistHooks, resolveCronRunReceiptTerminalStatus } from "./run-receipts.js";
import { publishCronRuntimeRows } from "./runtime-publication.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import type {
  CronRunMode,
  CronServiceState,
  CronWakeMode,
  DeferredCronNotifications,
} from "./state.js";
import { emit, isImmediateCronRunMode } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import {
  createCronOwnerExecutionIdentityAdmission,
  drainCronTaskDeliveryProjections,
  tryFinishCronTaskRunWithoutHistory,
} from "./task-runs.js";
import { createCronOutcomeEvent, recordCronOutcomeForJob } from "./timer-outcome-events.js";
import { applyOutcomeToAuthoritativeJob } from "./timer-outcomes.js";
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
  const runId = prepared.runId;
  let finalized = false;
  let supersedeReason: string | undefined;
  let receiptSettlementDisposition: CronRunReceiptSettlementDisposition | undefined;

  try {
    let coreResult: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
    try {
      coreResult = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        taskId: prepared.taskId,
        activeJobMarker: prepared.activeJobMarker,
        owningCronLaneTaskMarker: prepared.owningCronLaneTaskMarker,
        streamBatch: prepared.streamBatch,
        streamScheduleKey: prepared.streamScheduleKey,
        streamSourceIdentity: prepared.streamSourceIdentity,
        runReceipt: prepared.runReceipt,
        executionIdentity: createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: prepared.runReceipt,
          taskId: prepared.taskId,
          flowId: prepared.flowId,
        }),
      });
    } catch (err) {
      if (err instanceof CronRunReceiptRevisionError && err.reason === "owner-unavailable") {
        receiptSettlementDisposition = "owner-unavailable";
      }
      coreResult = authorCronRunCompletion(state, executionJob, {
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
    const endedAt = state.deps.nowMs();
    const triggerSkipped = coreResult.status === "ok" && coreResult.triggerEval?.fired === false;
    const outcome = {
      ...coreResult,
      jobId,
      job: prepared.admittedJob,
      taskRunId,
      activeJobMarker: prepared.activeJobMarker,
      runReceipt: prepared.runReceipt,
      startedAt,
      endedAt,
    };
    const outcomeOptions = {
      emit: false,
      request: {
        preserveCadence: isImmediateCronRunMode(mode),
        scheduleOwnershipAtMs: prepared.scheduleOwnershipAtMs,
      },
    };
    const emitMissingTerminal = (required = false) => {
      const tracker = prepared.terminalTracker;
      if ((!tracker && !required) || tracker?.emitted) {
        return;
      }
      const job =
        prepared.activeJobMarker?.jobRemoved === true
          ? executionJob
          : state.store?.jobs.find((entry) => entry.id === jobId);
      // Queued calls carry a tracker for dedupe. A removed direct run has no
      // tracker, but still needs one durable terminal event/history/task outcome.
      emitCronRunFinished(
        state,
        {
          jobId,
          action: "finished",
          job,
          status: triggerSkipped ? "skipped" : coreResult.status,
          completionStatus: triggerSkipped ? "failed" : coreResult.completionStatus,
          error: triggerSkipped
            ? "queued manual run skipped: trigger condition not met"
            : coreResult.error,
          deliveryError: coreResult.deliveryState.error,
          deliverySuppressionReason: coreResult.deliveryState.deliverySuppressionReason,
          summary: triggerSkipped ? undefined : coreResult.summary,
          diagnostics: coreResult.diagnostics,
          delivered: coreResult.deliveryState.delivered,
          deliveryStatus: coreResult.deliveryState.status,
          delivery: coreResult.delivery,
          sessionId: coreResult.sessionId,
          sessionKey: coreResult.sessionKey,
          runId,
          runAtMs: startedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          nextRunAtMs: job?.state.nextRunAtMs,
          model: coreResult.model,
          provider: coreResult.provider,
          usage: coreResult.usage,
        },
        tracker,
        taskRunId,
        {
          errorClassification: triggerSkipped ? undefined : coreResult.errorClassification,
          failureNotificationDetail: triggerSkipped
            ? undefined
            : coreResult.failureNotificationDetail,
        },
      );
    };
    const finishRemovedRun = () => {
      finishCronRunReceipt({
        handle: prepared.runReceipt,
        status: resolveCronRunReceiptTerminalStatus(
          triggerSkipped ? "skipped" : coreResult.status,
          coreResult.triggerEval?.fired,
        ),
        finishedAtMs: endedAt,
        error: coreResult.error,
      });
      finalized = true;
      emitMissingTerminal(true);
    };
    if (prepared.activeJobMarker?.jobRemoved === true) {
      finishRemovedRun();
      return;
    }
    let notifySetupTimeout = coreResult.isolatedAgentSetupTimeout !== undefined;
    await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      const job = state.store?.jobs.find((entry) => entry.id === jobId);
      if (prepared.activeJobMarker?.jobRemoved === true || !job) {
        notifySetupTimeout = false;
        finishRemovedRun();
        return;
      }
      const postPersistNotifications: DeferredCronNotifications = [];
      if (!triggerSkipped) {
        const taskJob = structuredClone(job);
        applyOutcomeToAuthoritativeJob(state, taskJob, outcome, {
          ...outcomeOptions,
          deferredNotifications: [],
        });
        recordCronOutcomeForJob(state, taskJob, { ...outcome, job: executionJob });
      }
      let removedJob: CronJob | undefined;
      try {
        const committed = commitCronRuntimeRows({
          state,
          jobIds: [jobId],
          operationLabel: "cron.manual-run-finalization",
          transactionHooks: cronRunReceiptPersistHooks({
            state,
            handle: prepared.runReceipt,
            terminal: {
              status: triggerSkipped ? "skipped" : coreResult.status,
              finishedAtMs: endedAt,
              error: coreResult.error,
              ...(receiptSettlementDisposition
                ? { disposition: receiptSettlementDisposition }
                : {}),
            },
          }),
          mutate: ({ database, jobs }) => {
            const current = jobs.get(jobId);
            if (!current) {
              return { value: undefined };
            }
            const removed = applyOutcomeToAuthoritativeJob(state, current, outcome, {
              ...outcomeOptions,
              triggerStateRetired: isCronRunTriggerStateRetiredInDatabase({
                database,
                handle: prepared.runReceipt,
              }),
              deferredNotifications: postPersistNotifications,
            });
            return {
              ...(removed ? { deleteJobIds: [jobId] } : { upsertJobIds: [jobId] }),
              value: { job: structuredClone(current), removed },
            };
          },
        });
        if (!committed) {
          return;
        }
        removedJob = committed.removed ? committed.job : undefined;
        runPostPersistCronNotifications(state, postPersistNotifications);
        applyCronRuntimeRowsToState(
          state,
          committed.removed ? [] : [committed.job],
          committed.removed ? [jobId] : [],
          { publish: false },
        );
        if (triggerSkipped) {
          tryFinishCronTaskRunWithoutHistory(state, {
            taskRunId,
            status: coreResult.status,
            error: coreResult.error,
            endedAt,
            summary: coreResult.summary,
            childSessionKey: coreResult.sessionKey,
            triggerEval: coreResult.triggerEval,
          });
        }
        // Retirement stops live publication, not the exact receipt's durable
        // completion. Manual force runs retain their reservation-time schedule owner.
        if (!isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
          finalized = true;
          return;
        }
        if (!triggerSkipped) {
          emitCronRunFinished(
            state,
            {
              ...createCronOutcomeEvent(committed.job, outcome),
              runId,
            },
            prepared.terminalTracker,
            taskRunId,
            {
              triggerEval: coreResult.triggerEval,
              scriptResult: {
                scriptStateChanged: coreResult.scriptStateChanged,
                scriptState: coreResult.scriptState,
              },
              errorClassification: coreResult.errorClassification,
              failureNotificationDetail: coreResult.failureNotificationDetail,
            },
          );
        }
        publishCronRuntimeRows(state);
        await recomputeUnownedCronSchedules(state, {
          recomputeExpired: true,
          ...(isImmediateCronRunMode(mode) ? { preserveExpiredPacedNextRunJobId: jobId } : {}),
        });
      } catch (error) {
        if (error instanceof CronRunReceiptRevisionError) {
          // A retired reservation cannot clear a successor's same-millisecond marker.
          if (isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
            supersedeReason = error.message;
          }
          notifySetupTimeout = false;
          return;
        }
        throw error;
      }
      if (removedJob) {
        emit(state, { jobId: removedJob.id, action: "removed", job: removedJob });
      }
      finalized = true;
    });
    if (supersedeReason) {
      await supersedeActivatedCronRun({
        state,
        jobId,
        reservationIdentity: prepared.reservationIdentity,
        runReceipt: prepared.runReceipt,
        reason: supersedeReason,
      });
    }
    if (notifySetupTimeout && isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      maybeNotifyManualIsolatedSetupTimeout(state, {
        jobId,
        job: executionJob,
        isolatedAgentSetupTimeout: coreResult.isolatedAgentSetupTimeout,
      });
    }
    if (finalized && isCronActiveJobMarkerCurrent(prepared.activeJobMarker)) {
      armTimer(state);
    }
    emitMissingTerminal();
  } finally {
    await drainCronTaskDeliveryProjections();
    // A failed row write leaves the exact receipt for recovery of its terminal
    // task fact. Only local liveness and admission ownership retire here.
    releaseLocalCronRunReceiptOwnership(prepared.runReceipt);
    try {
      releaseQueuedCronRun(state, prepared.jobId, prepared.reservationIdentity);
    } finally {
      clearManualCronJobActive(state, jobId, prepared.activeJobMarker);
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
      await finishPreparedManualRun(state, activeRun, mode);
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
    queuedRun = runWithGatewayIndependentRootWorkContinuation(async () => {
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
                emitCronRunFinished(
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
    }, "cron:manual-run");
  } catch (error) {
    activationSettled.resolve();
    releaseCallerAuthority?.();
    throw error;
  }
  void queuedRun
    .catch((err: unknown) => {
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
      emitCronRunFinished(
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
    });
  return await acceptance.promise;
}

/** Enqueues manual wake text through the cron wake API. */
export function wakeNow(
  state: CronServiceState,
  opts: { mode: CronWakeMode; text: string; sessionKey?: string; agentId?: string },
) {
  return wake(state, opts);
}
