import {
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SessionRestartRecoveryTombstoneError,
} from "../../config/sessions/lifecycle.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDiagnosticTraceContextFromActiveScope } from "../../infra/diagnostic-trace-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import {
  hasCommittedReplyOperationOutcome,
  type ReplyOperation,
  type ReplyTurnKind,
} from "./reply-run-registry.js";

export class QueuedFollowupLifecycleInvalidatedError extends Error {}

export function rejectLifecycleInvalidatedWork(params: {
  kind: ReplyTurnKind;
  message: string;
  restartRecoveryTombstone?: boolean;
  transientSessionChange?: boolean;
  workStartInvalidated?: boolean;
}): never {
  if (params.kind === "queued_followup") {
    const error = new QueuedFollowupLifecycleInvalidatedError(params.message);
    if (params.restartRecoveryTombstone === true) {
      Object.assign(error, { code: SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE });
    }
    throw error;
  }
  if (params.restartRecoveryTombstone === true) {
    throw new SessionRestartRecoveryTombstoneError(params.message);
  }
  if (params.kind === "visible" && params.transientSessionChange === true) {
    throw new SessionWorkStartChangedError(params.message);
  }
  if (params.workStartInvalidated) {
    throw new SessionWorkStartInvalidatedError(params.message);
  }
  throw new Error(params.message);
}

/** Active queue policy cannot deliver a new input through an already committed predecessor. */
export function mayRetainActiveReplyAdmission(
  kind: ReplyTurnKind,
  operation: ReplyOperation | undefined,
): boolean {
  return (
    kind !== "visible" || operation === undefined || !hasCommittedReplyOperationOutcome(operation)
  );
}

export function assertReplyAdmissionGeneration(params: {
  admitting: boolean;
  interrupted: boolean;
  expectedGeneration: string;
  currentGeneration: string;
}): void {
  if (
    !params.admitting ||
    params.interrupted ||
    params.expectedGeneration !== params.currentGeneration
  ) {
    throw new SessionWorkStartChangedError("Session changed while waiting for state admission.");
  }
}

/** Closed admission diagnostics distinguish finalization from transport and lifecycle failures. */
export function observeReplyAdmissionBoundary(
  kind: ReplyTurnKind,
  stage: "closing-predecessor-wait" | "predispatch-refused",
  operation?: ReplyOperation,
  error?: unknown,
): void {
  try {
    const trace = createDiagnosticTraceContextFromActiveScope();
    createSubsystemLogger("auto-reply/reply-turn-admission").info("reply_admission_boundary", {
      traceId: trace.traceId,
      requestSpanId: trace.spanId,
      kind,
      stage,
      predecessorPhase: operation?.phase,
      predecessorCommitted: operation ? hasCommittedReplyOperationOutcome(operation) : false,
      failure:
        error instanceof SessionWorkStartChangedError
          ? "session-changed"
          : error instanceof SessionWorkStartInvalidatedError
            ? "session-invalidated"
            : error
              ? "unclassified"
              : undefined,
    });
  } catch {
    /* Admission and input custody do not depend on diagnostics. */
  }
}

export type ReplyTurnAdmission =
  | {
      status: "owned";
      operation: ReplyOperation;
      sessionEntry?: SessionEntry;
      databaseClaim?: SessionAdmissionDatabaseClaim;
    }
  | {
      status: "skipped";
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      activeOperation?: ReplyOperation;
      sessionEntry?: SessionEntry;
      lifecycleAdmission?: SessionWorkAdmissionLease;
    };
