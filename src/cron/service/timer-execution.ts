import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { isCronWithinActiveHours } from "../active-hours.js";
import { isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId, tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { readDefaultProactiveJobReceiptsAsync } from "../proactive-job-receipt.js";
import { resolveCronRunAdmissionSource } from "../run-authority.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronToolsAllowExecTargetRecoveryError } from "../scheduled-tool-policy.js";
import { isCronScratchEffectivelyEmpty } from "../scratch-contract.js";
import { readCronScratchSnapshot } from "../scratch-read.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import { appendCronPayloadText, cronStreamScheduleKey } from "../stream-schedule.js";
import type {
  CronJob,
  CronJobExecutionResult,
  CronStoredJob,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
  CronRunDeliveryResult,
  CronTriggerEvalOutcome,
} from "../types.js";
import { abortErrorMessage } from "./execution-errors.js";
import { waitForCronExecutionIdle } from "./execution-idle.js";
import type { CronServiceState, CronSessionRunPreparation } from "./state.js";
import {
  type ExecuteJobCoreOptions,
  resolveMainSessionCronDeliveryContext,
} from "./timer-execution-timeout.js";
import { wake } from "./wake.js";

/** Executes a cron job without mutating persisted job state. */
export async function executeJobCore(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal?: AbortSignal,
  initialOptions?: ExecuteJobCoreOptions,
): Promise<CronJobExecutionResult> {
  let options = initialOptions;
  const resolveAbortError = () => ({
    status: "error" as const,
    error: abortErrorMessage(abortSignal),
  });
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  const assertCurrent = () => {
    abortSignal?.throwIfAborted();
    options?.deliveryAttemptFence?.assertCurrent();
    if (!isCronActiveJobMarkerCurrent(options?.activeJobMarker)) {
      throw new Error("Gateway restarting.");
    }
  };
  if (job.schedule.kind === "on-exit") {
    const originalOptions = options;
    const waitForIdle: NonNullable<ExecuteJobCoreOptions["waitForIdle"]> = async (
      ownSessionKey,
      signal,
      ownReplyOperation,
    ) => {
      const signals = [abortSignal, signal, originalOptions?.idleAdmission?.signal].filter(
        (entry): entry is AbortSignal => entry !== undefined,
      );
      const currentSignal = AbortSignal.any(signals);
      const assertIdleOwnerCurrent = async () => {
        originalOptions?.idleAdmission?.assertCurrent();
        await originalOptions?.assertRunCurrent?.();
        originalOptions?.idleAdmission?.assertCurrent();
        assertCurrent();
        currentSignal.throwIfAborted();
      };
      originalOptions?.onLaneWait?.({ waiting: true });
      try {
        await waitForCronExecutionIdle(state, job, {
          activeJobMarker: originalOptions?.activeJobMarker,
          ownSessionKey,
          ownReplyOperation,
          signal: currentSignal,
          assertCurrent: assertIdleOwnerCurrent,
        });
      } finally {
        originalOptions?.onLaneWait?.({ waiting: false });
      }
    };
    options = { ...options, waitForIdle };
  }
  const agentId = tryResolveCronJobEffectiveAgentId(
    job,
    state.deps.resolveDefaultAgentId
      ? state.deps.resolveDefaultAgentId()
      : state.deps.defaultAgentId,
  );
  if (agentId) {
    const receipts = await readDefaultProactiveJobReceiptsAsync(state.deps.storePath, [agentId]);
    assertCurrent();
    const receipt = receipts[agentId];
    if (
      receipt?.phase === "pending" &&
      (receipt.jobId === job.id || receipt.convertedJobIds?.includes(job.id))
    ) {
      return {
        status: "error",
        error: "Automation migration is incomplete; run openclaw doctor --fix",
      };
    }
  }
  if (
    !isCronWithinActiveHours(
      job.activeHours,
      state.deps.nowMs(),
      state.deps.resolveUserTimezone?.(),
    )
  ) {
    return {
      status: "skipped",
      summary: "Outside this automation's active hours",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
    };
  }
  if (job.idleOnly && state.deps.isExecutionIdle?.(job) === false) {
    if (options?.waitForIdle) {
      await options.waitForIdle();
      assertCurrent();
      if (
        !isCronWithinActiveHours(
          job.activeHours,
          state.deps.nowMs(),
          state.deps.resolveUserTimezone?.(),
        )
      ) {
        return {
          status: "skipped",
          summary: "Outside this automation's active hours",
          executionStarted: false,
          delivered: false,
          deliveryAttempted: false,
        };
      }
    } else {
      return {
        status: "skipped",
        summary: "Automation deferred while its agent is busy",
        admissionDeferred: true,
        admissionDeferredReason: "busy",
        executionStarted: false,
        delivered: false,
        deliveryAttempted: false,
      };
    }
  }
  let sessionPreparation: CronSessionRunPreparation | undefined;
  try {
    if (
      (job.payload.kind === "agentTurn" || job.payload.kind === "systemEvent") &&
      (job.sessionTarget === "main" || job.sessionTarget.startsWith("session:"))
    ) {
      const target = state.deps.resolveSessionEventTarget?.({
        agentId: job.agentId,
        sessionKey: resolveCronSessionTargetSessionKey(job.sessionTarget),
      });
      if (target?.agentId && target.sessionKey) {
        const { prepareAutomationSystemEvents } = await import("../../infra/system-events.js");
        sessionPreparation = {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          notices: await prepareAutomationSystemEvents(
            resolveSystemEventQueueKey(target.sessionKey, target.agentId),
            job.id,
            job.state.runningAtMs,
          ),
        };
        assertCurrent();
        sessionPreparation.notices.assertCurrent();
      }
    }
    if (job.payload.kind === "agentTurn" && job.payload.skipIfScratchEmpty) {
      const snapshot = await readCronScratchSnapshot(
        state.deps.storePath,
        { kind: "job", jobId: job.id, createdAtMsFallback: job.createdAtMs },
        {},
        { assertCurrent, signal: abortSignal },
      );
      assertCurrent();
      sessionPreparation?.notices.assertCurrent();
      if (sessionPreparation) {
        sessionPreparation.scratch = snapshot?.state ?? { currentRevision: 0 };
      }
      if (
        !sessionPreparation?.notices.events.length &&
        isCronScratchEffectivelyEmpty(snapshot?.state.scratch?.content)
      ) {
        return {
          status: "skipped",
          summary: "Automation scratch is explicitly empty",
          executionStarted: false,
          delivered: false,
          deliveryAttempted: false,
        };
      }
    }
    const execTargetRecoveryError = resolveCronToolsAllowExecTargetRecoveryError({
      jobId: job.id,
      requirement: job.toolsAllowExecTargetRequirement,
      execTarget: job.toolsAllowExecTarget,
    });
    if (execTargetRecoveryError) {
      return {
        status: "error",
        error: execTargetRecoveryError,
        diagnostics: createCronRunDiagnosticsFromError("cron-preflight", execTargetRecoveryError, {
          nowMs: state.deps.nowMs,
        }),
      };
    }
    if (options?.streamScheduleKey !== undefined || options?.streamSourceIdentity !== undefined) {
      // Defense in depth over the locked admission checks: stream-origin work must
      // carry both the source definition and logical identity, and both must still
      // match the execution snapshot.
      const currentKey =
        job.schedule.kind === "stream" ? cronStreamScheduleKey(job.schedule) : undefined;
      if (
        options.streamScheduleKey === undefined ||
        options.streamSourceIdentity === undefined ||
        currentKey !== options.streamScheduleKey ||
        job.state.streamSourceIdentity !== options.streamSourceIdentity
      ) {
        return { status: "skipped", error: "stream batch source no longer current" };
      }
    }
    let effectiveJob = job;
    let triggerEval: CronTriggerEvalOutcome | undefined;
    if (job.trigger) {
      const evaluator = state.deps.evaluateCronTrigger;
      if (!evaluator) {
        return {
          status: "error",
          error: "cron trigger evaluator is unavailable",
          ...cronScriptFailureMetadata("trigger", "runtime_unavailable"),
        };
      }
      const evaluation = await evaluator({
        deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
        job,
        script: job.trigger.script,
        state: job.state.triggerState,
        streamBatch: options?.streamBatch,
        abortSignal,
        executionIdentity: options?.executionIdentity,
      });
      sessionPreparation?.notices.assertCurrent();
      // Trigger scripts may settle after cancellation; never start payload work
      // or persist trigger results for a run that has already been aborted.
      if (abortSignal?.aborted) {
        return resolveAbortError();
      }
      if (evaluation.kind === "busy") {
        state.deps.log.debug({ jobId: job.id }, "cron: trigger evaluation skipped while busy");
        return {
          status: "ok",
          triggerEval: { fired: false, stateChanged: false, busy: true },
        };
      }
      if (evaluation.kind === "error") {
        return {
          status: "error",
          error: `cron trigger evaluation failed (${evaluation.code}): ${evaluation.error}`,
          ...cronScriptFailureMetadata("trigger", evaluation.code),
          triggerEval: { fired: false, stateChanged: false },
        };
      }
      const stateChanged = Object.hasOwn(evaluation, "state");
      triggerEval = {
        fired: evaluation.fire,
        stateChanged,
        ...(stateChanged ? { state: evaluation.state } : {}),
      };
      if (!evaluation.fire) {
        return { status: "ok", triggerEval };
      }
      if (evaluation.message !== undefined) {
        effectiveJob = { ...job, payload: appendCronPayloadText(job.payload, evaluation.message) };
      }
    }
    if (options?.assertRunCurrent) {
      await options.assertRunCurrent();
      if (options.activeJobMarker?.cancellation?.kind === "requested") {
        return { status: "error", error: options.activeJobMarker.cancellation.reason };
      }
      if (abortSignal?.aborted) {
        return resolveAbortError();
      }
      if (!isCronActiveJobMarkerCurrent(options.activeJobMarker)) {
        return { status: "error", error: "Gateway restarting." };
      }
    }
    if (effectiveJob.payload.kind === "script") {
      const result = await executeScriptCronJob(state, effectiveJob, abortSignal, options);
      return triggerEval ? { ...result, triggerEval } : result;
    }
    if (options?.streamBatch !== undefined) {
      effectiveJob = {
        ...effectiveJob,
        payload: appendCronPayloadText(effectiveJob.payload, options.streamBatch),
      };
    }
    if (
      effectiveJob.sessionTarget === "main" ||
      (effectiveJob.sessionTarget.startsWith("session:") &&
        effectiveJob.payload.kind === "agentTurn")
    ) {
      const result = await executeMainSessionCronJob(
        state,
        effectiveJob,
        abortSignal,
        options,
        sessionPreparation,
      );
      // Trigger execution already spent this occurrence; a later admission deferral cannot replay it.
      return triggerEval ? { ...result, admissionDeferred: false, triggerEval } : result;
    }

    const result = await executeDetachedCronJob(state, effectiveJob, abortSignal, options);
    return triggerEval ? { ...result, triggerEval } : result;
  } finally {
    sessionPreparation?.notices.release();
  }
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal: AbortSignal | undefined,
  options?: ExecuteJobCoreOptions,
  sessionPreparation?: CronSessionRunPreparation,
): Promise<CronJobExecutionResult> {
  const text =
    job.payload.kind === "agentTurn"
      ? job.payload.message
      : job.payload.kind === "systemEvent"
        ? job.payload.text.trim()
        : undefined;
  if (!text) {
    return {
      status: "skipped",
      error: "main job requires non-empty systemEvent or agentTurn text",
    };
  }
  if (!state.deps.runSessionEvent) {
    return {
      status: "error",
      error: "Session event execution is unavailable; restart the Gateway and retry",
    };
  }
  const assertCurrent = () => {
    abortSignal?.throwIfAborted();
    options?.deliveryAttemptFence?.assertCurrent();
    if (!isCronActiveJobMarkerCurrent(options?.activeJobMarker)) {
      throw new Error("Gateway restarting.");
    }
  };
  const deliveryContext = await resolveMainSessionCronDeliveryContext(state, job);
  assertCurrent();
  await options?.assertRunCurrent?.();
  assertCurrent();
  return await state.deps.runSessionEvent({
    waitForIdle: options?.waitForIdle,
    admissionSource: resolveCronRunAdmissionSource(job),
    sessionPreparation,
    deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
    onExecutionStarted: options?.onExecutionStarted,
    onLaneWait: options?.onLaneWait,
    executionIdentity: options?.executionIdentity,
    job,
    text,
    abortSignal,
    prepare: options?.assertRunCurrent,
    assertCurrent,
    deliveryContext,
  });
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal: AbortSignal | undefined,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome & CronRunTelemetry & CronRunDeliveryResult & { nextCheck?: CronNextCheckProposal }
> {
  const interrupted = () => {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error" as const,
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  };
  if (job.payload.kind === "command") {
    if (!state.deps.runCommandJob) {
      const error = "cron command runner is not configured";
      return {
        status: "skipped",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
          severity: "warn",
          nowMs: state.deps.nowMs,
        }),
      };
    }
    const res = await state.deps.runCommandJob({
      deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
      job,
      abortSignal,
    });
    if (
      abortSignal?.aborted &&
      !(
        abortSignal.reason instanceof Error &&
        abortSignal.reason.name === "TimeoutError" &&
        res.failureNotificationDetail?.kind === "command-timeout" &&
        res.failureNotificationDetail.mode === "wall-clock"
      )
    ) {
      return interrupted();
    }
    return {
      status: res.status,
      error: res.error,
      errorClassification: res.errorClassification,
      deliveryError: res.deliveryError,
      deliverySuppressionReason: res.deliverySuppressionReason,
      deliveryState: res.deliveryState,
      summary: res.summary,
      delivered: res.delivered,
      deliveryAttempted: res.deliveryAttempted,
      delivery: res.delivery,
      diagnostics: res.diagnostics,
      failureNotificationDetail: res.failureNotificationDetail,
    };
  }

  if (job.payload.kind !== "agentTurn") {
    const error = 'isolated job requires payload.kind="agentTurn" or "command"';
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (abortSignal?.aborted) {
    return interrupted();
  }

  const res = await state.deps.runIsolatedAgentJob({
    waitForIdle: options?.waitForIdle,
    deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
    job,
    admissionSource: resolveCronRunAdmissionSource(job),
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
    onLaneWait: options?.onLaneWait,
    executionIdentity: options?.executionIdentity,
  });

  if (abortSignal?.aborted) {
    return interrupted();
  }

  return {
    status: res.status,
    error: res.error,
    errorClassification: res.errorClassification,
    executionStarted: res.executionStarted,
    admissionDeferred: res.admissionDeferred,
    admissionDeferredReason: res.admissionDeferredReason,
    // Forward the post-run delivery failure recorded on an otherwise
    // successful run so the service can persist it as `lastDeliveryError` and
    // emit it on the finished event for CLI/UI/API run logs (#95419).
    deliveryError: res.deliveryError,
    deliverySuppressionReason: res.deliverySuppressionReason,
    deliveryState: res.deliveryState,
    nextCheck: res.nextCheck,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
    failureNotificationDetail: res.failureNotificationDetail,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

async function executeScriptCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  options?: ExecuteJobCoreOptions,
) {
  if (state.deps.cronConfig?.triggers?.enabled === false) {
    return {
      status: "error" as const,
      error:
        "cron script payload execution is disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended scripts",
    };
  }
  if (!state.deps.runScriptJob) {
    return {
      status: "error" as const,
      error: "cron script payload executor is unavailable",
      ...cronScriptFailureMetadata("payload", "runtime_unavailable"),
    };
  }
  const expectedTarget = await state.deps.captureSessionEventTarget?.(job);
  abortSignal?.throwIfAborted();
  await options?.assertRunCurrent?.();
  const result = await state.deps.runScriptJob({
    deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
    job,
    streamBatch: options?.streamBatch,
    abortSignal,
    executionIdentity: options?.executionIdentity,
  });
  // Script runners may settle after ignoring an abort. Recheck both operator
  // cancellation and scheduler ownership before any notify/wake side effect.
  if (!isCronActiveJobMarkerCurrent(options?.activeJobMarker)) {
    return { status: "error" as const, error: "Gateway restarting." };
  }
  if (abortSignal?.aborted) {
    return { status: "error" as const, error: abortErrorMessage(abortSignal) };
  }
  if (options?.assertRunCurrent) {
    await options.assertRunCurrent();
    if (options.activeJobMarker?.cancellation?.kind === "requested") {
      return { status: "error" as const, error: options.activeJobMarker.cancellation.reason };
    }
    if (!isCronActiveJobMarkerCurrent(options.activeJobMarker)) {
      return { status: "error" as const, error: "Gateway restarting." };
    }
    if (abortSignal?.aborted) {
      return { status: "error" as const, error: abortErrorMessage(abortSignal) };
    }
  }
  if (result.status !== "ok") {
    return result;
  }
  if (result.nextCheck && !job.pacing) {
    return {
      status: "error" as const,
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      ...cronScriptFailureMetadata("payload", "invalid_input"),
    };
  }

  const notify = result.notify?.trim() ? result.notify : undefined;
  if ((job.sessionTarget === "main" && notify) || result.wake) {
    const agentId = resolveCronJobEffectiveAgentId(
      job,
      state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
    );
    const deliveryContext =
      job.sessionTarget === "main"
        ? await resolveMainSessionCronDeliveryContext(state, job)
        : undefined;
    await options?.assertRunCurrent?.();
    abortSignal?.throwIfAborted();
    options?.deliveryAttemptFence?.assertCurrent();
    const eventOptions = { agentId, ...(deliveryContext ? { deliveryContext } : {}) };
    if (job.sessionTarget === "main" && notify && !result.wake) {
      state.deps.enqueueSystemEvent(notify, {
        ...eventOptions,
        contextKey: `cron:${job.id}:script`,
      });
    }
    if (result.wake) {
      if (!expectedTarget) {
        return {
          status: "error" as const,
          error:
            "Script follow-up has no original session target; inspect its result and request a fresh follow-up",
        };
      }
      const wakeResult = await wake(state, {
        mode: result.wake,
        text: notify ?? `script job ${job.name} completed`,
        agentId,
        sessionKey: job.sessionKey,
        expectedTarget,
      });
      if (!wakeResult.ok) {
        return { status: "error" as const, error: wakeResult.reason ?? "Wake was refused" };
      }
    }
  }
  return {
    status: "ok" as const,
    ...(notify ? { summary: notify } : {}),
    delivered: result.delivered,
    deliveryAttempted: result.deliveryAttempted,
    deliveryError: result.deliveryError,
    deliverySuppressionReason: result.deliverySuppressionReason,
    deliveryState: result.deliveryState,
    delivery: result.delivery,
    diagnostics: result.diagnostics,
    nextCheck: result.nextCheck,
    scriptStateChanged: result.stateChanged === true,
    ...(result.stateChanged === true ? { scriptState: result.state } : {}),
  };
}
