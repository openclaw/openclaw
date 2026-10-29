import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { SessionWorkStartError } from "../../config/sessions/session-work-start.js";
import type { ReplyTurnKind } from "../../sessions/session-controller.js";

/** Identifies queued follow-up work invalidated before it acquires the turn. */
export class QueuedFollowupLifecycleInvalidatedError extends Error {}

/** Preserves each turn kind's lifecycle-invalidated error contract. */
export function rejectLifecycleInvalidatedWork(params: {
  kind: ReplyTurnKind;
  message: string;
  error?: SessionWorkStartError;
  transientSessionChange?: boolean;
}): never {
  if (params.kind === "queued_followup") {
    const error = new QueuedFollowupLifecycleInvalidatedError(params.message, {
      cause: params.error,
    });
    throw error;
  }
  if (params.kind === "visible" && params.transientSessionChange === true) {
    throw new SessionWorkStartChangedError(params.message);
  }
  throw params.error ?? new Error(params.message);
}
