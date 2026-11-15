import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { waitForSessionRunIdle } from "../../sessions/session-controller.wait.js";
import type { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { clearCronJobActive } from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { cronEventPayload } from "../event-source.js";
import { isPluginCommandCronJob } from "../plugin-command-schedule.js";
import { resolveCronContinuationSessionKey } from "../session-target.js";
import { cronSourceIdentity, ownsCronSource } from "../source-schedule.js";
import type { CronQueuedRun } from "../store/run-queue.types.js";
import { hasUnstartedCronAdmission } from "./admission-deferred.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import { assertExecutionPolicy } from "./jobs-validation.js";
import { clearManualCronJobActive, markManualCronJobActive } from "./ops-shared.js";
import { createCronRunHandle } from "./run-history.js";
import type { CronRunOptions as RunOptions } from "./run-queue-requests.js";
import { awaitCronRunQueueTurn, wakeCronRunQueues } from "./run-queue-wake.js";
import { createCronReceiptExecutionIdentity, markServiceCronJobActive } from "./run-receipts.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import {
  emit,
  isImmediateCronRunMode,
  type CronRunResult,
  type CronServiceState,
} from "./state.js";
import { ensureLoaded } from "./store.js";
import type { ConditionFiredRunSlot, ConditionFiredWait } from "./timer-execution-timeout.js";
import { authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

/** Transient payloads and reply promises only; the worker owns queue order and capacity. */
export type CronLaunchContext = {
  job: CronQueuedRun["job"];
  receipt: CronQueuedRun["runReceipt"];
  context: OpenClawStateWorkerContext;
  options: RunOptions;
  generation: number;
  batch: { notified: boolean };
  started?: boolean;
  preparation?: { agentId: string; controller: AbortController };
  eventTransferred?: boolean;
  removeCancellation?: () => void;
  completion: ReturnType<typeof createDeferredCore<CronRunResult>>;
  activation: ReturnType<typeof createDeferredCore<void>>;
  receiptSettlement?: Promise<void>;
};

/**
 * A fired condition stops counting as a check and takes a run slot for its payload. A timed
 * check holds no slot, so it waits, holding neither, for the queue drain to hand it one in due
 * order, and asks again each time the queue moves. A failed request is retried the same way.
 */
async function takeRunSlot(
  state: CronServiceState,
  run: CronQueuedRun,
  pending: CronLaunchContext,
  wait: ConditionFiredWait,
): Promise<ConditionFiredRunSlot> {
  const { context } = pending;
  const signal = wait.signal ?? new AbortController().signal;
  // A stop ends the wait. A reload handover does not: like runs already executing here, the
  // payload goes on, and the replacement's drain hands it the slot.
  const ended = () =>
    signal.aborted || (state.lifecycleGeneration !== pending.generation && !state.handedOver);
  const settle = async () => {
    const { job, runSlot, stale } = await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({
        type: "cron.settleConditionCheck",
        input: {
          storeKey: state.deps.storeKey,
          jobId: run.job.id,
          receiptId: run.runReceipt.receiptId,
        },
      }),
    );
    if (job) {
      applyCronRuntimeRowsToState(state, [job]);
      // Its check is free for the next waiting condition, and a waiting payload needs a drain
      // that reads its wait: one already running may have read the queue before it.
      void state.op.then(() => wakeCronRunQueues(state));
    }
    return stale ? "stale" : runSlot;
  };
  let next: ReturnType<typeof awaitCronRunQueueTurn> | undefined;
  let waited = false;
  try {
    while (!ended()) {
      // Registered before asking, so a slot handed out in between still wakes this run.
      next = awaitCronRunQueueTurn(state, signal);
      const answer = await settle().catch((error: unknown) => {
        state.deps.log.warn(
          { jobId: run.job.id, err: String(error) },
          "cron: run slot request failed; still waiting",
        );
        return false as const;
      });
      if (answer === true) {
        return waited ? "taken-after-wait" : "taken";
      }
      if (answer === "stale") {
        // Before any wait a stale receipt goes ahead: the checks that follow the trigger stop it.
        return waited ? "stopped" : "taken";
      }
      if (!waited) {
        waited = true;
        wait.onWait?.(true);
      }
      await next.turn;
    }
    return "stopped";
  } finally {
    next?.cancel();
    if (waited) {
      wait.onWait?.(false);
    }
  }
}

export async function launchCronRun(
  state: CronServiceState,
  entry: CronQueuedRun,
  pending: CronLaunchContext,
  cancel: (reason: string) => Promise<void>,
) {
  const { options } = pending;
  const continuationSession = resolveCronContinuationSessionKey(entry.job);
  if (continuationSession) {
    // The queue parks a timed occurrence while its conversation is busy, so for those this
    // normally returns at once. Requested and event runs, and a turn that starts between the
    // drain and this launch, wait here with their slot held.
    await waitForSessionRunIdle(continuationSession, undefined, {
      signal: state.schedulerScope.signal,
    });
  }
  await ensureLoaded(state);
  pending.context.admission.assertCurrent();
  // Request authority ends at enqueue; occurrences restore the job's scheduled authority.
  // On-exit watchers still own their source until execution consumes the exit.
  options.onExit?.commitGuard();
  const current = state.store?.jobs.find((job) => job.id === entry.job.id);
  const force = options.mode === "force" || options.onExit !== undefined;
  const unavailable =
    state.deps.isAgentAvailable?.(entry.runReceipt.agentId, {
      deletionBlocked: false,
    }) === false;
  // The queue retires a command schedule while charging its final attempt. That attempt still
  // launches unless the definition changed again after the charge, such as an operator disable.
  const retiredByThisLaunch =
    isPluginCommandCronJob(current ?? entry.job) &&
    !isJobEnabled(entry.job) &&
    current?.updatedAtMs === entry.job.updatedAtMs;
  const disabledBeforeLaunch =
    current !== undefined &&
    isJobEnabled(pending.job) &&
    !isJobEnabled(current) &&
    !retiredByThisLaunch;
  // One final live owner/eligibility check; a disable may still race dispatch.
  if (
    state.stopped ||
    pending.generation !== state.lifecycleGeneration ||
    !current ||
    unavailable ||
    disabledBeforeLaunch ||
    current.state.runningReceiptId !== entry.runReceipt.receiptId ||
    (options.event && cronSourceIdentity(current) !== options.event.input.sourceIdentity) ||
    (!force && ((!isJobEnabled(current) && !retiredByThisLaunch) || current.state.autoDisabled)) ||
    (options.streamScheduleKey !== undefined &&
      !ownsCronSource(current, options.streamScheduleKey, options.streamSourceIdentity ?? ""))
  ) {
    await cancel(
      unavailable
        ? describeUnavailableCronAgent(entry.runReceipt.agentId)
        : !current
          ? "cron: job removed before launch"
          : disabledBeforeLaunch
            ? "cron: job disabled before launch"
            : "cron: job became ineligible before launch",
    );
    return;
  }
  const manual = options.source === "manual" || options.source === "event";
  const admittedJob = structuredClone(continuationSession ? current : entry.job);
  if (options.onExit) {
    admittedJob.enabled = false;
  }
  const executionJob = structuredClone(admittedJob);
  executionJob.payload = options.event
    ? cronEventPayload(entry.job, options.event.input)
    : (options.onExit?.payload?.(structuredClone(entry.job)) ??
      options.payload ??
      executionJob.payload);
  if (options.payload) {
    delete executionJob.operatorSource;
  }
  if (options.delivery) {
    const configured = executionJob.delivery;
    executionJob.delivery = {
      mode: "announce",
      ...configured,
      ...options.delivery,
      // Per-run routing cannot widen the stored delivery policy.
      ...(configured?.target === "owner"
        ? { target: "owner", to: undefined, threadId: undefined }
        : {}),
      ...(configured?.accountId ? { accountId: configured.accountId } : {}),
      ...(configured?.mode === "none" ? { mode: "none" } : {}),
      ...(configured?.directPolicy === "block" ? { directPolicy: "block" } : {}),
    };
    assertExecutionPolicy(executionJob);
  }
  if (isImmediateCronRunMode(options.mode)) {
    executionJob.state.nextRunAtMs = options.scheduleOwnershipAtMs;
    executionJob.trigger = options.evaluateTrigger ? executionJob.trigger : undefined;
  }
  const activeJobMarker = manual
    ? markManualCronJobActive(state, entry.job, entry.runReceipt)
    : markServiceCronJobActive(state, entry.job, entry.runReceipt);
  const taskRunId = createCronRunHandle({
    state,
    job: entry.job,
    startedAt: entry.runReceipt.startedAtMs,
    runReceipt: entry.runReceipt,
    publicRunId: options.runId,
  }).runId;
  emit(state, {
    jobId: entry.job.id,
    job: entry.job,
    action: "started",
    runAtMs: entry.runReceipt.startedAtMs,
  });
  if (state.stopped || pending.generation !== state.lifecycleGeneration) {
    await cancel("cron service stopped before execution");
    if (manual) {
      clearManualCronJobActive(state, entry.job.id, activeJobMarker);
    } else {
      clearCronJobActive(entry.job.id, activeJobMarker);
    }
    return;
  }
  pending.removeCancellation?.();
  pending.started = true;
  pending.activation.resolve();
  const onExit = options.onExit;
  let result: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
  try {
    result = await executeJobCoreWithTimeout(state, executionJob, {
      runId: taskRunId,
      migrationPending: entry.migrationPending,
      activeJobMarker,
      streamBatch: options.streamBatch,
      streamScheduleKey: options.streamScheduleKey,
      streamSourceIdentity: options.streamSourceIdentity,
      onConditionFired: (wait) => takeRunSlot(state, entry, pending, wait),
      runReceipt: entry.runReceipt,
      runReceiptContext: pending.context,
      executionIdentity: createCronReceiptExecutionIdentity(
        state,
        entry.runReceipt,
        pending.context,
      ),
      ...(onExit
        ? {
            idleAdmission: {
              signal: onExit.signal,
              assertCurrent: () => {
                onExit.commitGuard();
                if (activeJobMarker?.messageSourceAuthorityRevoked) {
                  throw new Error("cron on-exit source changed while awaiting idle execution");
                }
              },
            },
          }
        : {}),
    });
  } catch (error) {
    result = authorCronRunCompletion(executionJob, {
      status: "error",
      error: normalizeCronRunErrorText(error),
      interruptedByRestart:
        resolveAgentRunErrorLifecycleFields(error, undefined).stopReason === "restart",
    });
  }
  options.onTriggerDisposition?.(
    hasUnstartedCronAdmission(result) && result.admissionDeferredReason === "busy"
      ? "busy"
      : result.status === "error"
        ? "error"
        : result.status !== "ok"
          ? "dropped"
          : !executionJob.trigger || result.triggerEval?.fired
            ? "fired"
            : "dropped",
  );
  const finalized = await finalizeCompletedCronRunOutcomes(
    state,
    [
      {
        ...result,
        jobId: entry.job.id,
        job: admittedJob,
        taskRunId,
        activeJobMarker,
        runReceipt: entry.runReceipt,
        runReceiptContext: pending.context,
        startedAt: entry.runReceipt.startedAtMs,
        endedAt: state.deps.nowMs(),
        ...(manual
          ? {
              request: {
                executionJob,
                preserveCadence: isImmediateCronRunMode(options.mode),
                onExitWatcherCompletion: options.onExit !== undefined,
                scheduleOwnershipAtMs:
                  options.scheduleOwnershipAtMs ?? entry.runReceipt.startedAtMs,
                runId: options.runId,
                terminalTracker: options.runId ? options.terminalTracker : undefined,
              },
            }
          : {}),
      },
    ],
    {
      discardWhenStopped: true,
      onReceiptSettlement: (settlement) => {
        pending.receiptSettlement = settlement;
      },
    },
  );
  if (!manual && finalized.length && !pending.batch.notified) {
    pending.batch.notified = maybeNotifyIsolatedAgentSetupTimeout(state, {
      ...result,
      jobId: entry.job.id,
      job: executionJob,
    });
  }
  pending.removeCancellation?.();
  pending.completion.resolve({ ok: true, ran: true });
}
