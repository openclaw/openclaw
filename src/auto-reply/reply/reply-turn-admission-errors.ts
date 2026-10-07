import {
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SessionRestartRecoveryTombstoneError,
  SessionWorkStartChangedError,
} from "../../config/sessions/lifecycle.js";
import type { ReplyTurnKind } from "./reply-run-registry.contracts.js";

export class QueuedFollowupLifecycleInvalidatedError extends Error {}

export function rejectLifecycleInvalidatedWork(params: {
  kind: ReplyTurnKind;
  message: string;
  restartRecoveryTombstone?: boolean;
  transientSessionChange?: boolean;
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
  throw new Error(params.message);
}
