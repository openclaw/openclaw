import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { clearCronJobActive } from "../active-jobs.js";
import { describeUnavailableCronAgent } from "../agent-availability.js";
import { cronEventPayload } from "../event-source.js";
import { cronSourceIdentity, ownsCronSource } from "../source-schedule.js";
import type { CronQueuedRun } from "../store/run-queue.types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import { clearManualCronJobActive, markManualCronJobActive } from "./ops-shared.js";
import { createCronRunHandle } from "./run-history.js";
import type { CronRunOptions as RunOptions } from "./run-queue-requests.js";
import { markServiceCronJobActive } from "./run-receipts.js";
import {
  emit,
  isImmediateCronRunMode,
  type CronRunResult,
  type CronServiceState,
} from "./state.js";
import { ensureLoaded } from "./store.js";
import { authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";

/** Transient payloads and reply promises only; the worker owns queue order and capacity. */
export type CronLaunchContext = {
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
};

export async function launchCronRun(
  state: CronServiceState,
  entry: CronQueuedRun,
  pending: CronLaunchContext,
  cancel: (reason: string) => Promise<void>,
) {
  const { options } = pending;
  await ensureLoaded(state);
  pending.context.admission.assertCurrent();
  // Transfer ends the plugin's admission authority; this accepted occurrence
  // executes under live Cron/run/tool authority, not the retired source lease.
  if (!pending.eventTransferred) {
    options.commitGuard?.();
  }
  const current = state.store?.jobs.find((job) => job.id === entry.job.id);
  const force = options.mode === "force" || options.onExit !== undefined;
  const unavailable =
    state.deps.isAgentAvailable?.(entry.runReceipt.agentId, {
      deletionBlocked: false,
    }) === false;
  // One final live owner/eligibility check; a disable may still race dispatch.
  if (
    state.stopped ||
    pending.generation !== state.lifecycleGeneration ||
    !current ||
    unavailable ||
    current.state.runningReceiptId !== entry.runReceipt.receiptId ||
    (options.event && cronSourceIdentity(current) !== options.event.input.sourceIdentity) ||
    (!force && (!isJobEnabled(current) || current.state.autoDisabled)) ||
    (options.streamScheduleKey !== undefined &&
      !ownsCronSource(current, options.streamScheduleKey, options.streamSourceIdentity ?? ""))
  ) {
    await cancel(
      unavailable
        ? describeUnavailableCronAgent(entry.runReceipt.agentId)
        : "cron: job became ineligible before launch",
    );
    return;
  }
  const manual = options.source === "manual" || options.source === "event";
  const activeJobMarker = manual
    ? markManualCronJobActive(state, entry.job, entry.runReceipt)
    : markServiceCronJobActive(state, entry.job, entry.runReceipt);
  const admittedJob = structuredClone(entry.job);
  if (options.onExit) {
    admittedJob.enabled = false;
  }
  const executionJob = structuredClone(admittedJob);
  executionJob.payload = options.event
    ? cronEventPayload(entry.job, options.event.input)
    : (options.onExit?.payload?.(structuredClone(entry.job)) ??
      options.payload ??
      executionJob.payload);
  if (isImmediateCronRunMode(options.mode)) {
    executionJob.state.nextRunAtMs = options.scheduleOwnershipAtMs;
    executionJob.trigger = options.evaluateTrigger ? executionJob.trigger : undefined;
  }
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
  let executionBinding: Promise<void> | undefined;
  let result: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
  try {
    result = await executeJobCoreWithTimeout(state, executionJob, {
      runId: taskRunId,
      immediate: isImmediateCronRunMode(options.mode),
      activeJobMarker,
      streamBatch: options.streamBatch,
      streamScheduleKey: options.streamScheduleKey,
      streamSourceIdentity: options.streamSourceIdentity,
      runReceipt: entry.runReceipt,
      runReceiptContext: pending.context,
      executionIdentity: {
        ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        async onPostAdmission(admitted) {
          const token = admitted.executionIdentityToken;
          if (!token) {
            return;
          }
          // Trigger and payload admissions share one diagnostic link, never receipt authority.
          executionBinding ??= Promise.resolve()
            .then(async () => {
              const binding = parseExecutionIdentityAdmissionToken(token);
              if (binding.runId !== admitted.operationalRunInstance.runId) {
                throw new Error("Cron execution identity does not match its admitted run");
              }
              const retained = await runOpenClawStateWorkerOperation(pending.context, (scope) =>
                scope.execute({
                  type: "cron.bindReceiptExecution",
                  input: {
                    receiptId: entry.runReceipt.receiptId,
                    binding: { contextId: binding.contextId, executionId: binding.executionId },
                  },
                }),
              );
              if (!retained) {
                throw new Error("Cron execution identity binding was not retained");
              }
            })
            .catch((error: unknown) => {
              state.deps.log.warn(
                { err: String(error), jobId: entry.job.id },
                "cron: failed to retain execution identity binding",
              );
            });
          await executionBinding;
        },
      },
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
    result.triggerEval?.busy
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
    { discardWhenStopped: true },
  );
  if (!manual && finalized.length && !pending.batch.notified) {
    pending.batch.notified = maybeNotifyIsolatedAgentSetupTimeout(state, {
      ...result,
      jobId: entry.job.id,
      job: executionJob,
    });
  }
  pending.completion.resolve({ ok: true, ran: true });
}
