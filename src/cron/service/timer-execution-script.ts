import { isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronOperatorSourceRefusal } from "../operator-source-error.js";
import type { ScheduledOccurrence } from "../scheduled-occurrence.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { CronStoredJob } from "../types.js";
import { abortErrorMessage, cronAbortErrorClassification } from "./execution-errors.js";
import type { CronServiceState } from "./state.js";
import type { ExecuteJobCoreOptions } from "./timer-execution-timeout.js";
import { wake } from "./wake.js";

/** Runs a script payload for an admitted occurrence, then its notify and wake effects. */
export async function executeScriptCronJob(
  state: CronServiceState,
  job: CronStoredJob,
  occurrence: ScheduledOccurrence,
  abortSignal: AbortSignal | undefined,
  assertCurrent: () => void,
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
  const result = await state.deps
    .runScriptJob({
      occurrence,
      deliveryAttemptFence: options?.deliveryAttemptFence ?? null,
      job,
      streamBatch: options?.streamBatch,
      abortSignal,
      executionIdentity: options?.executionIdentity,
    })
    .catch(cronOperatorSourceRefusal);
  // Script runners may settle after ignoring an abort. Recheck both operator
  // cancellation and scheduler ownership before any notify/wake side effect.
  if (!isCronActiveJobMarkerCurrent(options?.activeJobMarker)) {
    return {
      status: "error" as const,
      error: "Gateway restarting.",
      errorClassification: { kind: "aborted" as const },
    };
  }
  if (abortSignal?.aborted) {
    return {
      status: "error" as const,
      error: abortErrorMessage(abortSignal),
      errorClassification: cronAbortErrorClassification(abortSignal),
    };
  }
  if (options?.assertRunCurrent) {
    await options.assertRunCurrent();
    if (options.activeJobMarker?.cancellation?.kind === "requested") {
      return {
        status: "error" as const,
        error: options.activeJobMarker.cancellation.reason,
        errorClassification: { kind: "aborted" as const },
      };
    }
    if (!isCronActiveJobMarkerCurrent(options.activeJobMarker)) {
      return {
        status: "error" as const,
        error: "Gateway restarting.",
        errorClassification: { kind: "aborted" as const },
      };
    }
    if (abortSignal?.aborted) {
      return {
        status: "error" as const,
        error: abortErrorMessage(abortSignal),
        errorClassification: cronAbortErrorClassification(abortSignal),
      };
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

  const continuationKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const notify = result.notify?.trim() ? result.notify : undefined;
  if ((continuationKey && notify) || result.wake) {
    const target = {
      agentId:
        expectedTarget?.agentId ??
        resolveCronJobEffectiveAgentId(
          job,
          state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
        ),
      sessionKey: continuationKey
        ? (expectedTarget?.sessionKey ?? continuationKey)
        : job.sessionKey,
    };
    const deliveryContext =
      continuationKey && notify && !result.wake
        ? (expectedTarget?.deliveryContext ??
          (await state.deps.resolveOriginDeliveryContext?.(target)))
        : undefined;
    await options?.assertRunCurrent?.();
    abortSignal?.throwIfAborted();
    options?.deliveryAttemptFence?.assertCurrent();
    if (continuationKey && notify && !result.wake) {
      state.deps.enqueueSystemEvent(notify, {
        ...target,
        ...(deliveryContext ? { deliveryContext } : {}),
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
        agentId: target.agentId,
        sessionKey:
          continuationKey && result.wake === "next-heartbeat" ? undefined : target.sessionKey,
        expectedTarget,
        commitGuard: assertCurrent,
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
