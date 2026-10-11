import { BoardValidationError } from "../../boards/board-layout.js";
import { ModelSelectionLockedError } from "../../sessions/model-selection-error.js";
import {
  SessionGoalOperationError,
  SESSION_GOAL_OPERATION_ERROR_CODES,
} from "./goals-operations.types.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SqliteSessionMutationConflictError,
  SqliteTranscriptMutationConflictError,
} from "./session-mutation-conflict-error.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { SessionWorkStartChangedError } from "./work-start-error.js";

/** The write settled; callers must not retry it as a rolled-back operation. */
export class SessionActorStorageCommittedError<Value> extends Error {
  constructor(readonly outcome: Extract<SessionActorStorageOutcome<Value>, { kind: "committed" }>) {
    super(outcome.failure?.message ?? "Session actor publication failed after commit");
    this.name = "SessionActorStorageCommittedError";
  }
}

export function readSessionActorStorageResult<Value>(
  outcome: SessionActorStorageOutcome<Value>,
): Value {
  if (outcome.kind === "committed") {
    if (outcome.failure) {
      throw new SessionActorStorageCommittedError(outcome);
    }
    return outcome.value;
  }
  const error = outcome.error;
  switch (error.name) {
    case "SessionWorkStartChangedError":
      throw new SessionWorkStartChangedError(error.message);
    case "ModelSelectionLockedError":
      throw new ModelSelectionLockedError(error.message);
    case "SqliteTranscriptMutationConflictError":
      throw new SqliteTranscriptMutationConflictError(error.sessionId ?? "");
    case "SqliteSessionMutationConflictError":
      throw new SqliteSessionMutationConflictError(error.operationLabel ?? "");
    case "SessionEntryLifecycleUpsertConflictError":
      throw new SessionEntryLifecycleUpsertConflictError(error.sessionKey ?? "");
    case "SessionTranscriptWriterClaimReboundError":
      throw new SessionTranscriptWriterClaimReboundError(error.refusal);
    case "SessionPendingInputCustodyError":
      throw new SessionPendingInputCustodyError(error.message);
    case "SessionTranscriptReadFenceError":
      throw new SessionTranscriptReadFenceError(error.message);
    case "BoardValidationError":
      if (
        error.code === "conflict" ||
        error.code === "invalid_operation" ||
        error.code === "not_found"
      ) {
        throw new BoardValidationError(error.code, error.message);
      }
      break;
    case "SessionGoalOperationError":
      for (const code of SESSION_GOAL_OPERATION_ERROR_CODES) {
        if (error.code === code) {
          throw new SessionGoalOperationError(code, error.message);
        }
      }
      break;
    case "SyntaxError":
      throw new SyntaxError(error.message);
    case "RangeError":
      throw new RangeError(error.message);
    case "TypeError":
      throw new TypeError(error.message);
  }
  throw Object.assign(new Error(error.message), { name: error.name });
}
