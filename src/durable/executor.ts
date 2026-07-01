import type {
  DurableRuntimeRegistry,
  DurableRuntimeStepHandlerResult,
  DurableRuntimeStepSideEffectPolicy,
} from "./registry.js";
import type {
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeStep,
  DurableRuntimeStepType,
  DurableRuntimeStore,
  UpdateDurableRuntimeStepInput,
} from "./types.js";

export type DurableExecutorRunOnceOptions = {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  workerId: string;
  claimTtlMs?: number;
  operationKind?: string;
  stepType?: DurableRuntimeStepType;
  now?: () => number;
};

export type DurableExecutorRunOnceResult =
  | {
      claimed: false;
      reason: "no_runnable_step";
    }
  | {
      claimed: true;
      runtimeRunId: string;
      stepId: string;
      outcome:
        | DurableRuntimeStepHandlerResult["kind"]
        | "no_handler"
        | "handler_exception"
        | "claim_lost";
    };

const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;

function terminalRunStatus(run: DurableRuntimeRun): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "lost"
  );
}

function createJsonRef(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  refKind: DurableRuntimeRef["refKind"];
  metadata: Record<string, unknown>;
  label: string;
  now: number;
}): DurableRuntimeRef {
  return params.store.createRef({
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    refKind: params.refKind,
    mediaType: "application/json",
    storageKind: "inline",
    storageUri: `inline:durable-step:${params.step.stepId}:${params.label}`,
    metadata: params.metadata,
    now: params.now,
  });
}

function clearStepClaimFields(workerId: string): {
  claimedBy: null;
  claimExpiresAt: null;
  heartbeatAt: null;
} {
  void workerId;
  return {
    claimedBy: null,
    claimExpiresAt: null,
    heartbeatAt: null,
  };
}

function isStepClaimOwned(params: {
  store: DurableRuntimeStore;
  step: DurableRuntimeStep;
  workerId: string;
}): boolean {
  return params.store
    .listSteps(params.step.runtimeRunId)
    .some((step) => step.stepId === params.step.stepId && step.claimedBy === params.workerId);
}

function markClaimLost(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  now: number;
}): DurableExecutorRunOnceResult {
  params.store.appendEvent({
    runtimeRunId: params.run.runtimeRunId,
    eventType: "runtime.step.claim_lost",
    eventTime: params.now,
    stepId: params.step.stepId,
    payload: {
      stepType: params.step.stepType,
      workerId: params.workerId,
    },
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "claim_lost",
  };
}

function updateOwnedStep(params: {
  store: DurableRuntimeStore;
  step: DurableRuntimeStep;
  workerId: string;
  input: Omit<UpdateDurableRuntimeStepInput, "runtimeRunId" | "stepId" | "expectedClaimedBy">;
}): DurableRuntimeStep | undefined {
  return params.store.updateStep({
    runtimeRunId: params.step.runtimeRunId,
    stepId: params.step.stepId,
    expectedClaimedBy: params.workerId,
    ...params.input,
  });
}

function markNoHandler(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  now: number;
}): DurableExecutorRunOnceResult {
  const updatedStep = updateOwnedStep({
    store: params.store,
    step: params.step,
    workerId: params.workerId,
    input: {
      status: "waiting",
      recoveryState: "unknown_after_side_effect",
      ...clearStepClaimFields(params.workerId),
      now: params.now,
    },
  });
  if (!updatedStep) {
    return markClaimLost(params);
  }
  params.store.updateRun({
    runtimeRunId: params.run.runtimeRunId,
    status: "waiting",
    recoveryState: "unknown_after_side_effect",
    heartbeatAt: null,
    now: params.now,
  });
  params.store.appendEvent({
    runtimeRunId: params.run.runtimeRunId,
    eventType: "runtime.step.no_handler",
    eventTime: params.now,
    stepId: params.step.stepId,
    payload: {
      stepType: params.step.stepType,
      workerId: params.workerId,
    },
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "no_handler",
  };
}

function markHandlerException(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  now: number;
  err: unknown;
}): DurableExecutorRunOnceResult {
  if (!isStepClaimOwned(params)) {
    return markClaimLost(params);
  }
  const errorRef = createJsonRef({
    store: params.store,
    run: params.run,
    step: params.step,
    refKind: "error",
    label: "handler-exception",
    metadata: { message: String(params.err) },
    now: params.now,
  });
  const updatedStep = updateOwnedStep({
    store: params.store,
    step: params.step,
    workerId: params.workerId,
    input: {
      status: "failed",
      recoveryState: "terminal",
      errorRef: errorRef.refId,
      completedAt: params.now,
      ...clearStepClaimFields(params.workerId),
      now: params.now,
    },
  });
  if (!updatedStep) {
    return markClaimLost(params);
  }
  params.store.updateRun({
    runtimeRunId: params.run.runtimeRunId,
    status: "failed",
    recoveryState: "terminal",
    completedAt: params.now,
    heartbeatAt: null,
    now: params.now,
  });
  params.store.appendEvent({
    runtimeRunId: params.run.runtimeRunId,
    eventType: "runtime.step.handler_exception",
    eventTime: params.now,
    stepId: params.step.stepId,
    payload: {
      errorRef: errorRef.refId,
      workerId: params.workerId,
    },
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "handler_exception",
  };
}

function applyStepResult(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  now: number;
  result: DurableRuntimeStepHandlerResult;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
}): DurableExecutorRunOnceResult {
  const { store, run, step, workerId, now, result, sideEffectPolicy } = params;
  if (!isStepClaimOwned({ store, step, workerId })) {
    return markClaimLost({ store, run, step, workerId, now });
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
      workerId,
      input: {
        status: "succeeded",
        recoveryState: "terminal",
        outputRef,
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        ...clearStepClaimFields(workerId),
        now,
      },
    });
    if (!updatedStep) {
      return markClaimLost({ store, run, step, workerId, now });
    }
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.succeeded",
      eventTime: now,
      stepId: step.stepId,
      payload: { outputRef, workerId },
    });
    store.updateRun(
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
    const retryRequested = Boolean(
      result.retryAfterMs && (!step.maxAttempts || step.attempt < step.maxAttempts),
    );
    const retrySafe =
      sideEffectPolicy === "none" ||
      sideEffectPolicy === "idempotent" ||
      Boolean(step.idempotencyKey);
    const retryAllowed = retryRequested && retrySafe;
    if (retryRequested && !retrySafe) {
      const updatedStep = updateOwnedStep({
        store,
        step,
        workerId,
        input: {
          status: "waiting",
          recoveryState: "unknown_after_side_effect",
          errorRef: errorRef.refId,
          checkpointRef: result.checkpointRef ?? null,
          ...clearStepClaimFields(workerId),
          now,
        },
      });
      if (!updatedStep) {
        return markClaimLost({ store, run, step, workerId, now });
      }
      store.updateRun({
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
        },
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
        workerId,
        input: {
          status: "retry_scheduled",
          recoveryState: "retry_scheduled",
          attempt: step.attempt + 1,
          errorRef: errorRef.refId,
          checkpointRef: result.checkpointRef ?? null,
          ...clearStepClaimFields(workerId),
          now,
        },
      });
      if (!updatedStep) {
        return markClaimLost({ store, run, step, workerId, now });
      }
      store.updateRun({
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
        payload: { errorRef: errorRef.refId, timerId: timer.timerId, workerId },
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
      workerId,
      input: {
        status: "failed",
        recoveryState: "terminal",
        errorRef: errorRef.refId,
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        ...clearStepClaimFields(workerId),
        now,
      },
    });
    if (!updatedStep) {
      return markClaimLost({ store, run, step, workerId, now });
    }
    if (result.completeRun !== false) {
      store.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: "failed",
        recoveryState: "terminal",
        checkpointRef: result.checkpointRef ?? null,
        completedAt: now,
        heartbeatAt: null,
        now,
      });
    }
    store.appendEvent({
      runtimeRunId: run.runtimeRunId,
      eventType: "runtime.step.failed",
      eventTime: now,
      stepId: step.stepId,
      payload: { errorRef: errorRef.refId, workerId },
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
      workerId,
      input: {
        status: "waiting",
        recoveryState: "waiting_signal",
        checkpointRef: result.checkpointRef ?? null,
        ...clearStepClaimFields(workerId),
        now,
      },
    });
    if (!updatedStep) {
      return markClaimLost({ store, run, step, workerId, now });
    }
    store.updateRun({
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
      payload: { reason: result.reason, workerId },
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
      workerId,
      input: {
        status: "waiting",
        recoveryState: "waiting_timer",
        checkpointRef: result.checkpointRef ?? null,
        ...clearStepClaimFields(workerId),
        now,
      },
    });
    if (!updatedStep) {
      return markClaimLost({ store, run, step, workerId, now });
    }
    store.updateRun({
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
      payload: { timerId: timer.timerId, reason: result.reason, workerId },
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
    workerId,
    input: {
      status: "waiting",
      recoveryState: "unknown_after_side_effect",
      checkpointRef: result.checkpointRef ?? null,
      ...clearStepClaimFields(workerId),
      now,
    },
  });
  if (!updatedStep) {
    return markClaimLost({ store, run, step, workerId, now });
  }
  store.updateRun({
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
    payload: { reason: result.reason, workerId },
  });
  return {
    claimed: true,
    runtimeRunId: run.runtimeRunId,
    stepId: step.stepId,
    outcome: result.kind,
  };
}

export async function runDurableExecutorOnce(
  options: DurableExecutorRunOnceOptions,
): Promise<DurableExecutorRunOnceResult> {
  const now = options.now ?? (() => Date.now());
  const claimTime = now();
  const step = options.store.claimNextRunnableStep({
    operationKind: options.operationKind,
    stepType: options.stepType,
    workerId: options.workerId,
    claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
    now: claimTime,
  });
  if (!step) {
    return { claimed: false, reason: "no_runnable_step" };
  }
  const run = options.store.getRun(step.runtimeRunId);
  if (!run || terminalRunStatus(run)) {
    options.store.releaseStepClaim({
      runtimeRunId: step.runtimeRunId,
      stepId: step.stepId,
      workerId: options.workerId,
      now: now(),
    });
    return { claimed: false, reason: "no_runnable_step" };
  }
  const registration = options.registry.getStepHandlerRegistration(step.stepType);
  const handler = registration?.handler;
  const startTime = now();
  const runningStep = updateOwnedStep({
    store: options.store,
    step,
    workerId: options.workerId,
    input: {
      status: "running",
      recoveryState: "running",
      startedAt: step.startedAt ?? startTime,
      heartbeatAt: startTime,
      now: startTime,
    },
  });
  if (!runningStep) {
    return markClaimLost({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      now: startTime,
    });
  }
  options.store.updateRun({
    runtimeRunId: run.runtimeRunId,
    status: "running",
    recoveryState: "running",
    heartbeatAt: startTime,
    now: startTime,
  });
  options.store.appendEvent({
    runtimeRunId: run.runtimeRunId,
    eventType: "runtime.step.running",
    eventTime: startTime,
    stepId: step.stepId,
    payload: {
      stepType: step.stepType,
      workerId: options.workerId,
    },
  });
  if (!handler) {
    return markNoHandler({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      now: now(),
    });
  }

  try {
    const result = await handler({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      now,
      heartbeat: (payload?: Record<string, unknown>) => {
        const heartbeatAt = now();
        const heartbeatStep = updateOwnedStep({
          store: options.store,
          step,
          workerId: options.workerId,
          input: {
            heartbeatAt,
            now: heartbeatAt,
          },
        });
        if (!heartbeatStep) {
          options.store.appendEvent({
            runtimeRunId: run.runtimeRunId,
            eventType: "runtime.step.claim_lost",
            eventTime: heartbeatAt,
            stepId: step.stepId,
            payload: {
              phase: "heartbeat",
              stepType: step.stepType,
              workerId: options.workerId,
            },
          });
          return;
        }
        options.store.updateRun({
          runtimeRunId: run.runtimeRunId,
          heartbeatAt,
          now: heartbeatAt,
        });
        options.store.appendEvent({
          runtimeRunId: run.runtimeRunId,
          eventType: "runtime.step.heartbeat",
          eventTime: heartbeatAt,
          stepId: step.stepId,
          payload: { ...payload, workerId: options.workerId },
        });
      },
    });
    return applyStepResult({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      now: now(),
      result,
      sideEffectPolicy: registration?.sideEffectPolicy ?? "unknown",
    });
  } catch (err) {
    return markHandlerException({
      store: options.store,
      run,
      step,
      workerId: options.workerId,
      now: now(),
      err,
    });
  }
}
