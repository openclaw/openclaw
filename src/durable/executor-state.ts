import type { DurableExecutorRunOnceResult } from "./executor-types.js";
import type { DurableRuntimeStepSideEffectPolicy } from "./registry.js";
import type {
  DurableRuntimeRef,
  DurableRuntimeRun,
  DurableRuntimeStep,
  DurableRuntimeStore,
  UpdateDurableRuntimeRunInput,
  UpdateDurableRuntimeStepInput,
} from "./types.js";

export class DurableStepClaimLostError extends Error {
  constructor() {
    super("durable step claim lost");
    this.name = "DurableStepClaimLostError";
  }
}

export function terminalRunStatus(run: DurableRuntimeRun): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "lost"
  );
}

export function createJsonRef(params: {
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

export function clearStepClaimFields(): {
  claimedBy: null;
  claimExpiresAt: null;
  heartbeatAt: null;
} {
  return {
    claimedBy: null,
    claimExpiresAt: null,
    heartbeatAt: null,
  };
}

export function isStepClaimOwned(params: {
  store: DurableRuntimeStore;
  step: DurableRuntimeStep;
  claimToken: string;
}): boolean {
  return params.store
    .listSteps(params.step.runtimeRunId)
    .some((step) => step.stepId === params.step.stepId && step.claimedBy === params.claimToken);
}

export function markClaimLost(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
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
      claimToken: params.claimToken,
    },
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "claim_lost",
  };
}

export function updateOwnedStep(params: {
  store: DurableRuntimeStore;
  step: DurableRuntimeStep;
  claimToken: string;
  input: Omit<UpdateDurableRuntimeStepInput, "runtimeRunId" | "stepId" | "expectedClaimedBy">;
}): DurableRuntimeStep | undefined {
  return params.store.updateStep({
    runtimeRunId: params.step.runtimeRunId,
    stepId: params.step.stepId,
    expectedClaimedBy: params.claimToken,
    ...params.input,
  });
}

export function updateRunOrAbort(
  store: DurableRuntimeStore,
  input: UpdateDurableRuntimeRunInput,
): DurableRuntimeRun {
  const updated = store.updateRun(input);
  if (!updated) {
    throw new DurableStepClaimLostError();
  }
  return updated;
}

export function recordExecutionUncertainty(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  kind: "unknown_after_side_effect" | "requires_owner_decision";
  reason: "side_effect_uncertain" | "no_handler";
  detail?: string;
  now: number;
}): void {
  const sourceOwner = params.run.sourceOwner ?? "durable_execution_records";
  const sourceRef = params.run.sourceRef ?? params.run.runtimeRunId;
  const dedupeKey = `${params.reason}:${params.run.runtimeRunId}:${params.step.stepId}:${params.step.attempt}`;
  const fact = params.store.recordUncertaintyFact({
    sourceOwner,
    sourceRef,
    kind: params.kind,
    sourceRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    dedupeKey,
    facts: {
      reason: params.reason,
      detail: params.detail,
      attempt: params.step.attempt,
    },
    now: params.now,
  });
  params.store.createWakeObligation({
    sourceOwner,
    sourceRef,
    parentRunId: params.run.parentRuntimeRunId,
    targetKind: "run",
    targetRef: params.run.runtimeRunId,
    ownerKind: "run",
    ownerRef: params.run.runtimeRunId,
    targetResolutionStatus: "resolved",
    targetResolutionReason: "durable execution record owns the blocked step",
    reason: params.reason,
    factsRef: `uncertainty_facts:${fact.factId}`,
    sourceRunId: params.run.runtimeRunId,
    dedupeKey: `wake:${dedupeKey}`,
    metadata: {
      stepId: params.step.stepId,
      detail: params.detail,
    },
    now: params.now,
  });
}

function markNoHandlerInTransaction(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
}): DurableExecutorRunOnceResult {
  const updatedStep = updateOwnedStep({
    store: params.store,
    step: params.step,
    claimToken: params.claimToken,
    input: {
      status: "waiting",
      recoveryState: "requires_owner_decision",
      ...clearStepClaimFields(),
      now: params.now,
    },
  });
  if (!updatedStep) {
    throw new DurableStepClaimLostError();
  }
  updateRunOrAbort(params.store, {
    runtimeRunId: params.run.runtimeRunId,
    status: "blocked",
    recoveryState: "requires_owner_decision",
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
      claimToken: params.claimToken,
    },
  });
  recordExecutionUncertainty({
    store: params.store,
    run: params.run,
    step: params.step,
    kind: "requires_owner_decision",
    reason: "no_handler",
    detail: `No handler is registered for step type ${params.step.stepType}`,
    now: params.now,
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "no_handler",
  };
}

export function markNoHandler(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
}): DurableExecutorRunOnceResult {
  try {
    return params.store.withTransaction(() => markNoHandlerInTransaction(params));
  } catch (error) {
    if (error instanceof DurableStepClaimLostError) {
      return markClaimLost(params);
    }
    throw error;
  }
}

function markHandlerExceptionInTransaction(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
  err: unknown;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
}): DurableExecutorRunOnceResult {
  if (!isStepClaimOwned(params)) {
    throw new DurableStepClaimLostError();
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
  const sideEffectUncertain =
    (params.sideEffectPolicy === "non_idempotent" || params.sideEffectPolicy === "unknown") &&
    !params.step.idempotencyKey;
  if (sideEffectUncertain) {
    const updatedStep = updateOwnedStep({
      store: params.store,
      step: params.step,
      claimToken: params.claimToken,
      input: {
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
        errorRef: errorRef.refId,
        ...clearStepClaimFields(),
        now: params.now,
      },
    });
    if (!updatedStep) {
      throw new DurableStepClaimLostError();
    }
    updateRunOrAbort(params.store, {
      runtimeRunId: params.run.runtimeRunId,
      status: "waiting",
      recoveryState: "unknown_after_side_effect",
      heartbeatAt: null,
      now: params.now,
    });
    params.store.appendEvent({
      runtimeRunId: params.run.runtimeRunId,
      eventType: "runtime.step.handler_exception_unknown_side_effect",
      eventTime: params.now,
      stepId: params.step.stepId,
      payload: {
        errorRef: errorRef.refId,
        sideEffectPolicy: params.sideEffectPolicy,
        workerId: params.workerId,
        claimToken: params.claimToken,
      },
    });
    recordExecutionUncertainty({
      store: params.store,
      run: params.run,
      step: params.step,
      kind: "unknown_after_side_effect",
      reason: "side_effect_uncertain",
      detail: String(params.err),
      now: params.now,
    });
    return {
      claimed: true,
      runtimeRunId: params.run.runtimeRunId,
      stepId: params.step.stepId,
      outcome: "handler_exception",
    };
  }
  const updatedStep = updateOwnedStep({
    store: params.store,
    step: params.step,
    claimToken: params.claimToken,
    input: {
      status: "failed",
      recoveryState: "terminal",
      errorRef: errorRef.refId,
      completedAt: params.now,
      ...clearStepClaimFields(),
      now: params.now,
    },
  });
  if (!updatedStep) {
    throw new DurableStepClaimLostError();
  }
  updateRunOrAbort(params.store, {
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
      claimToken: params.claimToken,
    },
  });
  return {
    claimed: true,
    runtimeRunId: params.run.runtimeRunId,
    stepId: params.step.stepId,
    outcome: "handler_exception",
  };
}

export function markHandlerException(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  claimToken: string;
  now: number;
  err: unknown;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
}): DurableExecutorRunOnceResult {
  try {
    return params.store.withTransaction(() => markHandlerExceptionInTransaction(params));
  } catch (error) {
    if (error instanceof DurableStepClaimLostError) {
      return markClaimLost(params);
    }
    throw error;
  }
}
