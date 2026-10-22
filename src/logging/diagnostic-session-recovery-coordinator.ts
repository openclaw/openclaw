import { emitInternalDiagnosticEvent as emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { captureDiagnosticSessionOperation } from "./diagnostic-controller-projection.js";
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
  request: StuckSessionRecoveryRequest;
  classification: SessionAttentionClassification;
};

export function requestStuckSessionRecovery(params: RequestStuckSessionRecoveryParams): void {
  // Capture before the runtime's lazy import/first await, never adopt a later occupant.
  const operation = params.request.operation ?? captureDiagnosticSessionOperation(params.request);
  const request = { ...params.request, ...(operation ? { operation } : {}) };
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
    reason: params.classification.reason,
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
      stale: request.operation ? !request.operation.watchdog.snapshot().current : true,
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
