import {
  DurableStepClaimLostError,
  clearStepClaimFields,
  createJsonRef,
  isStepClaimOwned,
  markClaimLost,
  recordExecutionUncertainty,
  updateOwnedStep,
  updateRunOrAbort,
} from "./executor-state.js";
import type { DurableExecutorRunOnceResult } from "./executor-types.js";
import type {
  DurableRuntimeStepHandlerResult,
  DurableRuntimeStepSideEffectPolicy,
} from "./registry.js";
import type { DurableRuntimeRun, DurableRuntimeStep, DurableRuntimeStore } from "./types.js";

function applyStepResultInTransaction(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
  result: DurableRuntimeStepHandlerResult;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
}): DurableExecutorRunOnceResult {
  const { store, run, step, workerId, claimToken, now, result, sideEffectPolicy } = params;
  if (!isStepClaimOwned({ store, step, claimToken })) {
    throw new DurableStepClaimLostError();
  }

  if (result.kind === "succeeded") {
    const outputRef =
      result.outputRef ??
      (result.output
        ? createJsonRef({
            store,
            run,
            step,
            refKind: "output",
            label: "output",
            metadata: result.output,
            now,
          }).refId
        : undefined);
    const updatedStep = updateOwnedStep({
      store,
      step,
      claimToken,
      input: {
        status: "succeeded",
        recoveryState: "terminal",
        outputRef,
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        ...clearStepClaimFields(),
        now,
      },
    });
    if (!updatedStep) {
      throw new DurableStepClaimLostError();
    }
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.succeeded",
      eventTime: now,
      stepId: step.stepId,
      payload: { outputRef, workerId, claimToken },
    });
    updateRunOrAbort(
      store,
      result.completeRun
        ? {
            runtimeRunId: run.runtimeRunId,
            status: "succeeded",
            recoveryState: "terminal",
            checkpointRef: result.checkpointRef ?? null,
            completedAt: now,
            heartbeatAt: null,
            now,
          }
        : {
            runtimeRunId: run.runtimeRunId,
            status: "queued",
            recoveryState: "runnable",
            checkpointRef: result.checkpointRef ?? undefined,
            heartbeatAt: null,
            now,
          },
    );
    return {
      claimed: true,
      runtimeRunId: run.runtimeRunId,
      stepId: step.stepId,
      outcome: result.kind,
    };
  }

  if (result.kind === "failed") {
    const errorRef = createJsonRef({
      store,
      run,
      step,
      refKind: "error",
      label: "error",
      metadata: result.error ?? { message: "durable step failed" },
      now,
    });
    const retryRequested =
      result.retryAfterMs !== undefined &&
      Number.isFinite(result.retryAfterMs) &&
      result.retryAfterMs >= 0 &&
      (!step.maxAttempts || step.attempt < step.maxAttempts);
    const retrySafe =
      sideEffectPolicy === "none" ||
      sideEffectPolicy === "idempotent" ||
      Boolean(step.idempotencyKey);
    const retryAllowed = retryRequested && retrySafe;
    if (retryRequested && !retrySafe) {
      const updatedStep = updateOwnedStep({
        store,
        step,
        claimToken,
        input: {
          status: "waiting",
          recoveryState: "unknown_after_side_effect",
          errorRef: errorRef.refId,
          checkpointRef: result.checkpointRef ?? null,
          ...clearStepClaimFields(),
          now,
        },
      });
      if (!updatedStep) {
        throw new DurableStepClaimLostError();
      }
      updateRunOrAbort(store, {
        runtimeRunId: run.runtimeRunId,
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
        checkpointRef: result.checkpointRef ?? undefined,
        heartbeatAt: null,
        now,
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "runtime.step.retry_blocked_unknown_side_effect",
        eventTime: now,
        stepId: step.stepId,
        payload: {
          errorRef: errorRef.refId,
          retryAfterMs: result.retryAfterMs,
          sideEffectPolicy,
          workerId,
          claimToken,
        },
      });
      recordExecutionUncertainty({
        store,
        run,
        step,
        kind: "unknown_after_side_effect",
        reason: "side_effect_uncertain",
        detail: `Retry blocked for ${sideEffectPolicy} step without an idempotency key`,
        now,
      });
      return {
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "unknown_after_side_effect",
      };
    }
    if (retryAllowed) {
      const timer = store.createTimer({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        timerType: "retry",
        dueAt: now + Math.max(0, Math.trunc(result.retryAfterMs ?? 0)),
        metadata: { errorRef: errorRef.refId },
        now,
      });
      const updatedStep = updateOwnedStep({
        store,
        step,
        claimToken,
        input: {
          status: "retry_scheduled",
          recoveryState: "retry_scheduled",
          attempt: step.attempt + 1,
          errorRef: errorRef.refId,
          checkpointRef: result.checkpointRef ?? null,
          ...clearStepClaimFields(),
          now,
        },
      });
      if (!updatedStep) {
        throw new DurableStepClaimLostError();
      }
      updateRunOrAbort(store, {
        runtimeRunId: run.runtimeRunId,
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        checkpointRef: result.checkpointRef ?? undefined,
        heartbeatAt: null,
        now,
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "runtime.step.retry_scheduled",
        eventTime: now,
        stepId: step.stepId,
        payload: { errorRef: errorRef.refId, timerId: timer.timerId, workerId, claimToken },
      });
      return {
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: result.kind,
      };
    }
    const updatedStep = updateOwnedStep({
      store,
      step,
      claimToken,
      input: {
        status: "failed",
        recoveryState: "terminal",
        errorRef: errorRef.refId,
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        ...clearStepClaimFields(),
        now,
      },
    });
    if (!updatedStep) {
      throw new DurableStepClaimLostError();
    }
    if (result.completeRun !== false) {
      updateRunOrAbort(store, {
        runtimeRunId: run.runtimeRunId,
        status: "failed",
        recoveryState: "terminal",
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        heartbeatAt: null,
        now,
      });
    } else {
      updateRunOrAbort(store, {
        runtimeRunId: run.runtimeRunId,
        status: "queued",
        recoveryState: "runnable",
        checkpointRef: result.checkpointRef ?? undefined,
        heartbeatAt: null,
        now,
      });
    }
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.failed",
      eventTime: now,
      stepId: step.stepId,
      payload: { errorRef: errorRef.refId, workerId, claimToken },
    });
    return {
      claimed: true,
      runtimeRunId: run.runtimeRunId,
      stepId: step.stepId,
      outcome: result.kind,
    };
  }

  if (result.kind === "waiting_signal") {
    const updatedStep = updateOwnedStep({
      store,
      step,
      claimToken,
      input: {
        status: "waiting",
        recoveryState: "waiting_signal",
        checkpointRef: result.checkpointRef ?? null,
        ...clearStepClaimFields(),
        now,
      },
    });
    if (!updatedStep) {
      throw new DurableStepClaimLostError();
    }
    updateRunOrAbort(store, {
      runtimeRunId: run.runtimeRunId,
      status: "waiting_signal",
      recoveryState: "waiting_signal",
      checkpointRef: result.checkpointRef ?? undefined,
      heartbeatAt: null,
      now,
    });
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.waiting_signal",
      eventTime: now,
      stepId: step.stepId,
      payload: { reason: result.reason, workerId, claimToken },
    });
    return {
      claimed: true,
      runtimeRunId: run.runtimeRunId,
      stepId: step.stepId,
      outcome: result.kind,
    };
  }

  if (result.kind === "waiting_timer") {
    const timer = store.createTimer({
      runtimeRunId: run.runtimeRunId,
      stepId: step.stepId,
      timerType: result.timerType ?? "sleep",
      dueAt: result.dueAt,
      metadata: { reason: result.reason },
      now,
    });
    const updatedStep = updateOwnedStep({
      store,
      step,
      claimToken,
      input: {
        status: "waiting",
        recoveryState: "waiting_timer",
        checkpointRef: result.checkpointRef ?? null,
        ...clearStepClaimFields(),
        now,
      },
    });
    if (!updatedStep) {
      throw new DurableStepClaimLostError();
    }
    updateRunOrAbort(store, {
      runtimeRunId: run.runtimeRunId,
      status: "waiting_timer",
      recoveryState: "waiting_timer",
      checkpointRef: result.checkpointRef ?? undefined,
      heartbeatAt: null,
      now,
    });
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.waiting_timer",
      eventTime: now,
      stepId: step.stepId,
      payload: { timerId: timer.timerId, reason: result.reason, workerId, claimToken },
    });
    return {
      claimed: true,
      runtimeRunId: run.runtimeRunId,
      stepId: step.stepId,
      outcome: result.kind,
    };
  }

  const updatedStep = updateOwnedStep({
    store,
    step,
    claimToken,
    input: {
      status: "waiting",
      recoveryState: "unknown_after_side_effect",
      checkpointRef: result.checkpointRef ?? null,
      ...clearStepClaimFields(),
      now,
    },
  });
  if (!updatedStep) {
    throw new DurableStepClaimLostError();
  }
  updateRunOrAbort(store, {
    runtimeRunId: run.runtimeRunId,
    status: "waiting",
    recoveryState: "unknown_after_side_effect",
    checkpointRef: result.checkpointRef ?? undefined,
    heartbeatAt: null,
    now,
  });
  store.appendEvent({
    runtimeRunId: run.runtimeRunId,
    eventType: "runtime.step.side_effect_uncertain",
    eventTime: now,
    stepId: step.stepId,
    payload: { reason: result.reason, workerId, claimToken },
  });
  recordExecutionUncertainty({
    store,
    run,
    step,
    kind: "unknown_after_side_effect",
    reason: "side_effect_uncertain",
    detail: result.reason,
    now,
  });
  return {
    claimed: true,
    runtimeRunId: run.runtimeRunId,
    stepId: step.stepId,
    outcome: result.kind,
  };
}

export function applyStepResult(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
  result: DurableRuntimeStepHandlerResult;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
}): DurableExecutorRunOnceResult {
  try {
    return params.store.withTransaction(() => applyStepResultInTransaction(params));
  } catch (error) {
    if (error instanceof DurableStepClaimLostError) {
      return markClaimLost(params);
    }
    throw error;
  }
}
