import { applyStepResult } from "./executor-settlement.js";
import {
  DurableStepClaimLostError,
  markClaimLost,
  markHandlerException,
  markNoHandler,
  terminalRunStatus,
  updateOwnedStep,
  updateRunOrAbort,
} from "./executor-state.js";
import type {
  DurableExecutorRunOnceOptions,
  DurableExecutorRunOnceResult,
} from "./executor-types.js";
import type { DurableRuntimeStepHandlerResult } from "./registry.js";

export { reconcileExpiredDurableStepClaims } from "./executor-recovery.js";
export type { DurableExpiredStepClaimRecoveryResult } from "./executor-recovery.js";
export type {
  DurableExecutorRunOnceOptions,
  DurableExecutorRunOnceResult,
} from "./executor-types.js";

const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;

export async function runDurableExecutorOnce(
  options: DurableExecutorRunOnceOptions,
): Promise<DurableExecutorRunOnceResult> {
  const now = options.now ?? (() => Date.now());
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const operationKind = options.operationKind.trim();
  const operationVersion = (options.operationVersion ?? "1").trim();
  if (!operationKind || !operationVersion) {
    throw new Error(
      "Durable runtime executor requires an operationKind and operationVersion scope",
    );
  }
  if (!options.registry.getRuntime(operationKind, operationVersion)) {
    throw new Error(
      `Durable runtime executor operation is not registered: ${operationKind}@${operationVersion}`,
    );
  }
  const claimTime = now();
  const step = options.store.claimNextRunnableStep({
    operationKind,
    operationVersion,
    stepType: options.stepType,
    workerId: options.workerId,
    claimTtlMs,
    now: claimTime,
  });
  if (!step) {
    return { claimed: false, reason: "no_runnable_step" };
  }
  const claimToken = step.claimedBy!;
  const run = options.store.getRun(step.runtimeRunId);
  if (!run || terminalRunStatus(run)) {
    options.store.releaseStepClaim({
      runtimeRunId: step.runtimeRunId,
      stepId: step.stepId,
      claimToken,
      now: now(),
    });
    return { claimed: false, reason: "no_runnable_step" };
  }
  const registration = options.registry.getStepHandlerRegistration(
    run.operationKind,
    step.stepType,
    run.operationVersion,
  );
  const handler = registration?.handler;
  const startTime = now();
  try {
    options.store.withTransaction(() => {
      const runningStep = updateOwnedStep({
        store: options.store,
        step,
        claimToken,
        input: {
          status: "running",
          recoveryState: "running",
          startedAt: step.startedAt ?? startTime,
          heartbeatAt: startTime,
          now: startTime,
        },
      });
      if (!runningStep) {
        throw new DurableStepClaimLostError();
      }
      const runningRun = options.store.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: "running",
        recoveryState: "running",
        heartbeatAt: startTime,
        now: startTime,
      });
      if (!runningRun) {
        throw new DurableStepClaimLostError();
      }
      options.store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "runtime.step.running",
        eventTime: startTime,
        stepId: step.stepId,
        payload: {
          stepType: step.stepType,
          workerId: options.workerId,
          claimToken,
        },
      });
    });
  } catch (error) {
    if (!(error instanceof DurableStepClaimLostError)) {
      throw error;
    }
    return markClaimLost({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      claimToken,
      now: startTime,
    });
  }
  if (!handler) {
    return markNoHandler({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      claimToken,
      now: now(),
    });
  }

  let claimLost = false;
  let automaticHeartbeatError: unknown;
  const heartbeat = (payload?: Record<string, unknown>): boolean => {
    const heartbeatAt = now();
    let renewed = false;
    try {
      renewed = options.store.withTransaction(() => {
        const heartbeatStep = options.store.renewStepClaim({
          runtimeRunId: step.runtimeRunId,
          stepId: step.stepId,
          claimToken,
          claimTtlMs,
          now: heartbeatAt,
        });
        if (!heartbeatStep) {
          return false;
        }
        updateRunOrAbort(options.store, {
          runtimeRunId: run.runtimeRunId,
          heartbeatAt,
          now: heartbeatAt,
        });
        options.store.appendEvent({
          runtimeRunId: run.runtimeRunId,
          eventType: "runtime.step.heartbeat",
          eventTime: heartbeatAt,
          stepId: step.stepId,
          payload: { ...payload, workerId: options.workerId, claimToken },
        });
        return true;
      });
    } catch (error) {
      if (!(error instanceof DurableStepClaimLostError)) {
        throw error;
      }
    }
    if (!renewed) {
      if (!claimLost) {
        claimLost = true;
        options.store.appendEvent({
          runtimeRunId: run.runtimeRunId,
          eventType: "runtime.step.claim_lost",
          eventTime: heartbeatAt,
          stepId: step.stepId,
          payload: {
            phase: "heartbeat",
            stepType: step.stepType,
            workerId: options.workerId,
            claimToken,
          },
        });
      }
      return false;
    }
    return true;
  };
  const heartbeatTimer = setInterval(
    () => {
      try {
        heartbeat({ automatic: true });
      } catch (error) {
        automaticHeartbeatError ??= error;
      }
    },
    Math.max(1, Math.floor(claimTtlMs / 3)),
  );
  heartbeatTimer.unref?.();
  try {
    let handlerOutcome:
      | { ok: true; result: DurableRuntimeStepHandlerResult }
      | { ok: false; error: unknown };
    try {
      handlerOutcome = {
        ok: true,
        result: await handler({
          store: options.store,
          run,
          step,
          workerId: options.workerId,
          claimToken,
          now,
          heartbeat,
        }),
      };
    } catch (err) {
      handlerOutcome = { ok: false, error: err };
    }
    if (automaticHeartbeatError) {
      throw automaticHeartbeatError instanceof Error
        ? automaticHeartbeatError
        : new Error("Durable worker automatic heartbeat failed", {
            cause: automaticHeartbeatError,
          });
    }
    if (claimLost) {
      return {
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "claim_lost",
      };
    }
    if (!handlerOutcome.ok) {
      return markHandlerException({
        store: options.store,
        run,
        step,
        workerId: options.workerId,
        claimToken,
        now: now(),
        err: handlerOutcome.error,
        sideEffectPolicy: registration?.sideEffectPolicy ?? "unknown",
      });
    }
    return applyStepResult({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      claimToken,
      now: now(),
      result: handlerOutcome.result,
      sideEffectPolicy: registration?.sideEffectPolicy ?? "unknown",
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}
