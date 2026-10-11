import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  bindCronJobAdmittedRun,
  type CronActiveJobMarker,
  isCronActiveJobMarkerCurrent,
} from "../active-jobs.js";
import { resolveAdmittedCronCompletionStatus } from "../completion-status.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronAgentExecutionStarted, CronJob } from "../types.js";
import {
  registerActiveCronTaskRun,
  trackActiveCronTaskRunSettlement,
} from "./active-run-cancellation.js";
import { isDeferredCronAdmission } from "./admission-deferred.js";
import {
  createCronAgentWatchdog,
  CRON_AGENT_SETUP_WATCHDOG_MS,
  settleTimedOutCronRun,
} from "./agent-watchdog.js";
import { createCronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { abortErrorMessage, isSetupTimeoutErrorText } from "./execution-errors.js";
import {
  assertServiceCronRunReceiptCurrent,
  trackServiceCronRunReceiptSettlement,
} from "./run-receipts.js";
import type { CronServiceState } from "./state.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import type { CronJobRunResult, ExecuteJobCoreOptions } from "./timer-execution-timeout.js";
import { executeJobCore } from "./timer-execution.js";
import {
  type CronCoreRunOutcome,
  type CronRunProgress,
  resolveInterruptedRunProgress,
  withPrimaryWebhookInterruption,
  withPrimaryWebhookTrace,
} from "./timer-job-runner.interruption.js";
import { resolveDeliveryState } from "./timer-trigger.js";

type CronRunTimeout = { timeoutMs: number; reason: string };
type CronCoreRunOptions = {
  idleAdmission?: import("./state.js").CronIdleAdmissionSource;
  runId?: string;
  activeJobMarker?: CronActiveJobMarker;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  executionIdentity?: import("./state.js").CronExecutionIdentityAdmission;
} & (
  | { runReceipt: CronRunReceiptHandle; runReceiptContext: OpenClawStateWorkerContext }
  | { runReceipt?: undefined; runReceiptContext?: undefined }
);

async function deliverPrimaryWebhook(
  state: CronServiceState,
  job: CronJob,
  result: CronCoreRunOutcome,
  abortSignal: AbortSignal,
  progress: CronRunProgress,
  assertRunCurrent?: () => Promise<void>,
  activeJobMarker?: CronActiveJobMarker,
  deliveryAttemptFence?: CronCompletionDeliveryFence,
): Promise<CronCoreRunOutcome> {
  const settle = (settledResult: CronCoreRunOutcome) => {
    // Publish the terminal delivery fact before this async function resolves;
    // cancellation can win the outer race during the following microtask.
    progress.settledDeliveryResult ??= settledResult;
    return progress.settledDeliveryResult;
  };
  const plan = resolveCronDeliveryPlan(job);
  if (
    plan.mode !== "webhook" ||
    result.triggerEval?.fired === false ||
    isDeferredCronAdmission(job, result)
  ) {
    return result;
  }
  const undelivered = (error?: string, deliverySuppressionReason?: "empty") =>
    withPrimaryWebhookTrace({
      job,
      result,
      outcome: { status: "not-delivered", error },
      deliverySuppressionReason,
    });
  if (result.status !== "error" && !(typeof result.summary === "string" && result.summary.trim())) {
    return settle(undelivered(undefined, "empty"));
  }
  if (!state.deps.sendCronWebhook) {
    return undelivered("cron webhook delivery is unavailable");
  }

  const interruptionError = () => {
    const reason = abortErrorMessage(abortSignal);
    return abortSignal.reason instanceof Error && abortSignal.reason.name === "TimeoutError"
      ? `cron webhook delivery timed out: ${reason}`
      : `cron webhook delivery cancelled: ${reason}`;
  };
  if (abortSignal.aborted) {
    return undelivered(interruptionError());
  }

  if (assertRunCurrent) {
    await assertRunCurrent();
    if (activeJobMarker?.cancellation?.kind === "requested") {
      return undelivered(`cron webhook delivery cancelled: ${activeJobMarker.cancellation.reason}`);
    }
    if (!isCronActiveJobMarkerCurrent(activeJobMarker)) {
      return undelivered("Gateway restarting.");
    }
    if (abortSignal.aborted) {
      return undelivered(interruptionError());
    }
  }

  const startedAt = job.state.runningAtMs;
  const deliveredResult = withPrimaryWebhookTrace({
    job,
    result,
    outcome: { status: "delivered" },
  });
  let webhookAdapterEntered = false;
  try {
    await deliveryAttemptFence?.beforeAttempt();
    deliveryAttemptFence?.assertCurrent();
    webhookAdapterEntered = true;
    const outcome = await state.deps.sendCronWebhook({
      assertCurrent: deliveryAttemptFence?.assertCurrent,
      job,
      abortSignal,
      onDeliveryState: (delivery) => {
        progress.webhookDelivery = delivery;
      },
      event: {
        jobId: job.id,
        action: "finished",
        job,
        ...(typeof startedAt === "number" ? { runAtMs: startedAt } : {}),
        ...(typeof startedAt === "number"
          ? { durationMs: Math.max(0, state.deps.nowMs() - startedAt) }
          : {}),
        status: result.status,
        error: result.error,
        summary: result.summary,
        diagnostics: result.diagnostics,
        delivered: true,
        deliveryStatus: "delivered",
        delivery: deliveredResult.delivery,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
      },
    });
    if (outcome.error) {
      state.deps.log.warn({ jobId: job.id, err: outcome.error }, "cron: webhook delivery failed");
    }
    if (progress.settledDeliveryResult) {
      return progress.settledDeliveryResult;
    }
    if (abortSignal.aborted) {
      return withPrimaryWebhookInterruption({ job, result, outcome, error: interruptionError() });
    }
    return settle(withPrimaryWebhookTrace({ job, result, outcome }));
  } catch (error) {
    if (progress.settledDeliveryResult) {
      return progress.settledDeliveryResult;
    }
    const deliveryError = abortSignal.aborted ? interruptionError() : formatErrorMessage(error);
    state.deps.log.warn({ jobId: job.id, err: deliveryError }, "cron: webhook delivery failed");
    return settle(
      withPrimaryWebhookTrace({
        job,
        result,
        outcome: progress.webhookDelivery ?? {
          status: webhookAdapterEntered ? "unknown" : "not-delivered",
        },
        error: deliveryError,
      }),
    );
  }
}

/** Executes cron job core logic with the configured wall-clock timeout and watchdog cleanup. */
async function executeJobCoreWithTimeoutUnfinalized(
  state: CronServiceState,
  job: CronJob,
  opts?: CronCoreRunOptions,
): Promise<CronCoreRunOutcome> {
  const runAbortController = new AbortController();
  const progress: CronRunProgress = {};
  let commandSettlement: Promise<CronCoreRunOutcome> | undefined;
  const receiptSource = opts?.runReceipt
    ? { handle: opts.runReceipt, context: opts.runReceiptContext }
    : undefined;
  const assertRunCurrent = receiptSource
    ? () =>
        assertServiceCronRunReceiptCurrent(
          state,
          receiptSource.handle,
          opts?.activeJobMarker,
          receiptSource.context,
          runAbortController.signal,
        )
    : undefined;
  const deliveryAttemptFence = opts?.runReceipt
    ? createCronCompletionDeliveryFence({
        state,
        job,
        handle: opts.runReceipt,
        activeJobMarker: opts.activeJobMarker,
        signal: runAbortController.signal,
      })
    : undefined;
  const operatorCancellationMarker = Symbol("cron-operator-cancelled");
  const operatorCancellation = createDeferredCore<typeof operatorCancellationMarker>();
  const createInterruptionOutcome = async (
    interruption: CronRunTimeout | "cancelled",
    execution?: CronAgentExecutionStarted,
    watchdog?: ReturnType<typeof createCronAgentWatchdog>,
  ): Promise<CronCoreRunOutcome> => {
    const error =
      interruption === "cancelled"
        ? abortErrorMessage(runAbortController.signal)
        : interruption.reason;
    const deliveryError = `cron webhook delivery ${interruption === "cancelled" ? "cancelled" : "timed out"}: ${error}`;
    const settled = resolveInterruptedRunProgress({ progress, job, error: deliveryError });
    if (settled) {
      return settled;
    }
    if (interruption !== "cancelled") {
      await settleTimedOutCronRun(state, job, interruption.timeoutMs, execution, commandSettlement);
      if (commandSettlement) {
        const settledAfterCleanup = resolveInterruptedRunProgress({
          progress,
          job,
          error: deliveryError,
        });
        if (settledAfterCleanup) {
          return settledAfterCleanup;
        }
      }
    }
    const isolatedAgentSetupTimeout =
      interruption !== "cancelled" &&
      job.sessionTarget === "isolated" &&
      isSetupTimeoutErrorText(error) &&
      !watchdog?.observedLaneWait()
        ? { error, timeoutMs: CRON_AGENT_SETUP_WATCHDOG_MS, otherCronJobsActiveAtTimeout: false }
        : undefined;
    const result: CronCoreRunOutcome = {
      status: "error",
      error,
      // A timeout raised by this service-owned watchdog is authoritative even
      // when the interrupted main-session heartbeat has no model attribution.
      ...(interruption !== "cancelled" && {
        errorClassification: { kind: "reason", reason: "timeout" },
      }),
      // The abort race must retain attribution already reported by the runner.
      ...(execution && {
        provider: execution.provider,
        model: execution.model,
        sessionId: execution.sessionId,
        sessionKey: execution.sessionKey,
      }),
      ...(isolatedAgentSetupTimeout ? { isolatedAgentSetupTimeout } : {}),
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
    return withPrimaryWebhookInterruption({ job, result, error: deliveryError });
  };
  if (!isCronActiveJobMarkerCurrent(opts?.activeJobMarker)) {
    runAbortController.abort("Gateway restarting.");
    return await createInterruptionOutcome("cancelled");
  }
  const releaseCronTaskRun = registerActiveCronTaskRun({
    runId: opts?.runId ?? `cron-active:${job.id}`,
    controller: runAbortController,
    activeJobMarker: opts?.activeJobMarker,
    onCancel: () => operatorCancellation.resolve(operatorCancellationMarker),
  });
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  const onIdleSourceAbort = () => {
    if (!runAbortController.signal.aborted) {
      runAbortController.abort(opts?.idleAdmission?.signal.reason);
      operatorCancellation.resolve(operatorCancellationMarker);
    }
  };
  try {
    opts?.idleAdmission?.signal.addEventListener("abort", onIdleSourceAbort, { once: true });
    if (opts?.idleAdmission?.signal.aborted) {
      onIdleSourceAbort();
    }
    const timeout = createDeferredCore<CronRunTimeout>();

    // Agent runs report setup phases separately; defer the wall-clock
    // timeout until the runner starts so cold setup gets a clearer failure reason.
    const deferTimeoutUntilExecutionStart =
      job.payload.kind === "agentTurn" || job.payload.kind === "systemEvent";
    const watchdog =
      jobTimeoutMs === undefined
        ? undefined
        : createCronAgentWatchdog({
            deferUntilRunner: deferTimeoutUntilExecutionStart,
            jobTimeoutMs,
            triggerTimeout: (reason) => {
              if (!runAbortController.signal.aborted) {
                const timeoutError = new Error(reason);
                timeoutError.name = "TimeoutError";
                runAbortController.abort(timeoutError);
              }
              timeout.resolve({ timeoutMs: jobTimeoutMs, reason });
            },
          });
    // Unlimited runs still retain attribution when cancellation wins the race.
    let untimedExecution: CronAgentExecutionStarted | undefined;
    const accumulateExecution = (info?: CronAgentExecutionStarted) => {
      if (info) {
        untimedExecution = { ...untimedExecution, ...info };
      }
    };
    const noteLaneState = (info?: { waiting?: boolean }) => {
      if (info?.waiting === false) {
        watchdog?.noteLaneAdmitted();
        return;
      }
      watchdog?.noteLaneWait();
    };
    const noteRunnerStarted = (info?: CronAgentExecutionStarted) => {
      if (watchdog) {
        watchdog.noteRunnerStarted(info);
      } else {
        accumulateExecution(info);
      }
    };
    const trackExecution = !watchdog || deferTimeoutUntilExecutionStart;
    const executionIdentity = opts?.executionIdentity;
    const coreOptions: ExecuteJobCoreOptions = {
      idleAdmission: opts?.idleAdmission,
      deliveryAttemptFence,
      activeJobMarker: opts?.activeJobMarker,
      streamBatch: opts?.streamBatch,
      streamScheduleKey: opts?.streamScheduleKey,
      streamSourceIdentity: opts?.streamSourceIdentity,
      onExecutionStarted: trackExecution ? noteRunnerStarted : undefined,
      onExecutionPhase: trackExecution ? (watchdog?.notePhase ?? accumulateExecution) : undefined,
      onLaneWait: watchdog && deferTimeoutUntilExecutionStart ? noteLaneState : undefined,
      assertRunCurrent,
      executionIdentity: executionIdentity && {
        ...executionIdentity,
        onPostAdmission: (context) => {
          bindCronJobAdmittedRun(opts?.activeJobMarker, context, runAbortController.signal);
          return executionIdentity.onPostAdmission?.(context);
        },
      },
    };
    watchdog?.start();
    const corePromise = executeJobCore(state, job, runAbortController.signal, coreOptions);
    commandSettlement = job.payload.kind === "command" ? corePromise : undefined;
    const runPromise = corePromise.then(async (result) => {
      progress.completedCoreResult = result;
      return await deliverPrimaryWebhook(
        state,
        job,
        result,
        runAbortController.signal,
        progress,
        assertRunCurrent,
        opts?.activeJobMarker,
        deliveryAttemptFence,
      );
    });
    // Timeout/cancel projects an outcome before an abort-ignoring core settles;
    // keep the receipt and shutdown drain tied to the underlying promise.
    if (opts?.runReceipt) {
      trackServiceCronRunReceiptSettlement({
        state,
        handle: opts.runReceipt,
        settlement: runPromise,
      });
    }
    trackActiveCronTaskRunSettlement(
      runPromise,
      runAbortController.signal,
      opts?.runReceipt?.agentId ?? opts?.activeJobMarker?.agentId,
    );
    void runPromise.catch((err: unknown) => {
      if (runAbortController.signal.aborted) {
        state.deps.log.warn(
          { jobId: job.id, err: String(err) },
          `cron: job core rejected after abort: ${abortErrorMessage(runAbortController.signal)}`,
        );
      }
    });
    try {
      const first = await Promise.race([runPromise, timeout.promise, operatorCancellation.promise]);
      if (first === operatorCancellationMarker) {
        return await createInterruptionOutcome(
          "cancelled",
          watchdog?.activeExecution() ?? untimedExecution,
        );
      }
      return "status" in first
        ? first
        : await createInterruptionOutcome(first, watchdog?.activeExecution(), watchdog);
    } finally {
      watchdog?.dispose();
    }
  } finally {
    opts?.idleAdmission?.signal.removeEventListener("abort", onIdleSourceAbort);
    releaseCronTaskRun?.();
  }
}

export function authorCronRunCompletion<
  T extends Pick<
    CronJobRunResult,
    | "status"
    | "error"
    | "deliveryError"
    | "deliverySuppressionReason"
    | "deliveryState"
    | "delivery"
    | "delivered"
    | "deliveryAttempted"
  >,
>(job: CronJob, result: T) {
  const deliveryState =
    result.deliveryState ??
    resolveDeliveryState({
      job,
      runStatus: result.status,
      delivery: result.delivery,
      delivered: result.delivered,
      deliveryAttempted: result.deliveryAttempted,
      error: result.deliveryError ?? result.error,
      deliverySuppressionReason: result.deliverySuppressionReason,
    });
  return {
    ...result,
    deliveryState,
    completionStatus: resolveAdmittedCronCompletionStatus(
      job,
      result.status,
      deliveryState.status,
      deliveryState.deliverySuppressionReason,
    ),
  };
}

/** Authors completion after execution and primary delivery have both settled. */
export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
  opts?: CronCoreRunOptions,
) {
  const result = await executeJobCoreWithTimeoutUnfinalized(state, job, opts);
  return authorCronRunCompletion(job, result);
}
