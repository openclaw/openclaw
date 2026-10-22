import { emitInternalDiagnosticEvent as emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import type {
  StuckSessionRecoveryOutcome,
  StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";

export type RecoverStuckSession = (
  params: StuckSessionRecoveryRequest,
) => void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>;

type RequestStuckSessionRecoveryParams = {
  recover: RecoverStuckSession;
  request: StuckSessionRecoveryRequest & { operation: StuckSessionRecoveryRequest["operation"] };
  classification: SessionAttentionClassification;
};

export function requestStuckSessionRecovery(params: RequestStuckSessionRecoveryParams): void {
  // The producer captures before logging or awaiting; absence never adopts a later occupant.
  const operation = params.request.operation;
  if (!operation) {
    return;
  }
  const decision = operation.watchdog.decide();
  if (decision.action !== "stop" && decision.action !== "expire_cleanup") {
    return;
  }
  const request = {
    ...params.request,
    operation,
    allowActiveAbort: decision.action === "stop",
  };
  const sessionFields = {
    sessionId: request.sessionId,
    sessionKey: request.sessionKey,
    state: request.expectedState ?? "processing",
    stateGeneration: request.stateGeneration,
    ageMs: request.ageMs,
    queueDepth: request.queueDepth,
  };
  emitDiagnosticEvent({
    type: "session.recovery.requested",
    ...sessionFields,
    reason: decision.reason,
    activeWorkKind: params.classification.activeWorkKind,
    allowActiveAbort: request.allowActiveAbort,
  });
  const complete = (outcome: void | StuckSessionRecoveryOutcome) => {
    if (!outcome) {
      return;
    }
    // This is a projection only. Completion never declares idle or changes queue counts.
    emitDiagnosticEvent({
      type: "session.recovery.completed",
      ...sessionFields,
      activeWorkKind: outcome.activeWorkKind,
      status: outcome.status,
      action: outcome.action,
      outcomeReason: "reason" in outcome ? outcome.reason : undefined,
      released: "released" in outcome ? outcome.released || undefined : undefined,
      stale: !operation.watchdog.snapshot().current,
    });
  };
  const failed = (error: unknown) =>
    complete({
      status: "failed",
      action: "none",
      reason: "exception",
      error: String(error),
      sessionId: request.sessionId,
      sessionKey: request.sessionKey,
    });
  try {
    void Promise.resolve(params.recover(request)).then(complete, failed);
  } catch (error) {
    failed(error);
  }
}
