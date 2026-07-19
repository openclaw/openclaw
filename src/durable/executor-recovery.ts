import {
  DurableStepClaimLostError,
  recordExecutionUncertainty,
  terminalRunStatus,
  updateRunOrAbort,
} from "./executor-state.js";
import type { DurableRuntimeRegistry } from "./registry.js";
import type { DurableRuntimeStore } from "./types.js";

export type DurableExpiredStepClaimRecoveryResult = {
  scanned: number;
  requeued: number;
  requiresOwnerDecision: number;
  unknownAfterSideEffect: number;
  raced: number;
};

export function reconcileExpiredDurableStepClaims(options: {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  operationKind: string;
  operationVersion?: string;
  now?: number;
  limit?: number;
}): DurableExpiredStepClaimRecoveryResult {
  const operationKind = options.operationKind.trim();
  const operationVersion = (options.operationVersion ?? "1").trim();
  if (!operationKind || !operationVersion) {
    throw new Error("Expired durable step recovery requires an operationKind and version scope");
  }
  if (!options.registry.getRuntime(operationKind, operationVersion)) {
    throw new Error(
      `Durable runtime recovery operation is not registered: ${operationKind}@${operationVersion}`,
    );
  }
  const now = options.now ?? Date.now();
  const expired = options.store.listExpiredStepClaims({
    operationKind,
    operationVersion,
    now,
    limit: options.limit,
  });
  const result: DurableExpiredStepClaimRecoveryResult = {
    scanned: expired.length,
    requeued: 0,
    requiresOwnerDecision: 0,
    unknownAfterSideEffect: 0,
    raced: 0,
  };

  for (const step of expired) {
    const run = options.store.getRun(step.runtimeRunId);
    const claimToken = step.claimedBy;
    if (!run || terminalRunStatus(run) || !claimToken) {
      result.raced += 1;
      continue;
    }
    const registration = options.registry.getStepHandlerRegistration(
      run.operationKind,
      step.stepType,
      run.operationVersion,
    );
    const retrySafe =
      registration?.sideEffectPolicy === "none" ||
      registration?.sideEffectPolicy === "idempotent" ||
      Boolean(step.idempotencyKey);
    const resolution = !registration
      ? ("requires_owner_decision" as const)
      : retrySafe
        ? ("runnable" as const)
        : ("unknown_after_side_effect" as const);

    try {
      const recovered = options.store.withTransaction(() => {
        const recoveredStep = options.store.recoverExpiredStepClaim({
          runtimeRunId: step.runtimeRunId,
          stepId: step.stepId,
          expectedClaimedBy: claimToken,
          resolution,
          now,
        });
        if (!recoveredStep) {
          return false;
        }
        if (resolution === "runnable") {
          const hasOtherRunningStep = options.store
            .listSteps(run.runtimeRunId)
            .some(
              (candidate) =>
                candidate.stepId !== step.stepId &&
                candidate.status === "running" &&
                candidate.claimedBy !== undefined,
            );
          updateRunOrAbort(options.store, {
            runtimeRunId: run.runtimeRunId,
            status: hasOtherRunningStep ? "running" : "queued",
            recoveryState: hasOtherRunningStep ? "running" : "runnable",
            heartbeatAt: hasOtherRunningStep ? undefined : null,
            now,
          });
          options.store.appendEvent({
            runtimeRunId: run.runtimeRunId,
            eventType: "runtime.step.expired_claim_requeued",
            eventTime: now,
            stepId: step.stepId,
            payload: {
              operationKind,
              operationVersion,
              previousClaimToken: claimToken,
              sideEffectPolicy: registration?.sideEffectPolicy ?? "unknown",
            },
          });
          return true;
        }

        const requiresOwnerDecision = resolution === "requires_owner_decision";
        updateRunOrAbort(options.store, {
          runtimeRunId: run.runtimeRunId,
          status: requiresOwnerDecision ? "blocked" : "waiting",
          recoveryState: resolution,
          heartbeatAt: null,
          now,
        });
        options.store.appendEvent({
          runtimeRunId: run.runtimeRunId,
          eventType: requiresOwnerDecision
            ? "runtime.step.expired_claim_no_handler"
            : "runtime.step.expired_claim_side_effect_uncertain",
          eventTime: now,
          stepId: step.stepId,
          payload: {
            operationKind,
            operationVersion,
            previousClaimToken: claimToken,
            sideEffectPolicy: registration?.sideEffectPolicy ?? "unregistered",
          },
        });
        recordExecutionUncertainty({
          store: options.store,
          run,
          step,
          kind: requiresOwnerDecision ? "requires_owner_decision" : "unknown_after_side_effect",
          reason: requiresOwnerDecision ? "no_handler" : "side_effect_uncertain",
          detail: requiresOwnerDecision
            ? `No handler is registered for expired step type ${step.stepType}`
            : `Worker claim expired while ${step.stepType} may have produced side effects`,
          now,
        });
        return true;
      });
      if (!recovered) {
        result.raced += 1;
      } else if (resolution === "runnable") {
        result.requeued += 1;
      } else if (resolution === "requires_owner_decision") {
        result.requiresOwnerDecision += 1;
      } else {
        result.unknownAfterSideEffect += 1;
      }
    } catch (error) {
      if (!(error instanceof DurableStepClaimLostError)) {
        throw error;
      }
      result.raced += 1;
    }
  }
  return result;
}
