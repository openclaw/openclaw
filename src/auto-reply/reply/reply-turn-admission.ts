// Decides whether an inbound turn may start, queue, or abort a reply run.
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  type ReplyOperation,
  waitForReplyRunFollowupAdmission,
} from "./reply-run-registry.js";

/** Kinds of turns that compete for one reply run slot per session. */
export type ReplyTurnKind = "visible" | "heartbeat" | "queued_followup" | "control_abort";

/** Admission result for a reply turn attempting to own the session run slot. */
export type ReplyTurnAdmission =
  | { status: "owned"; operation: ReplyOperation }
  | {
      status: "skipped";
      reason: "active-run" | "aborted";
      activeOperation?: ReplyOperation;
    };

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Waits for or claims the per-session reply run slot. */
export async function admitReplyTurn(params: {
  sessionKey: string;
  sessionId: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  upstreamAbortSignal?: AbortSignal;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
}): Promise<ReplyTurnAdmission> {
  let sessionId = params.sessionId;
  const baseWaitTimeoutMs =
    params.waitTimeoutMs ??
    (params.kind === "queued_followup" ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
  while (true) {
    if (isAbortSignalAborted(params.upstreamAbortSignal)) {
      return { status: "skipped", reason: "aborted" };
    }
    try {
      return {
        status: "owned",
        operation: createReplyOperation({
          sessionKey: params.sessionKey,
          sessionId,
          resetTriggered: params.resetTriggered,
          routeThreadId: params.routeThreadId,
          upstreamAbortSignal: params.upstreamAbortSignal,
          respectFollowupAdmissionBarrier:
            params.kind === "queued_followup" || params.kind === "heartbeat",
        }),
      };
    } catch (error) {
      if (error instanceof ReplyRunFollowupAdmissionBlockedError) {
        if (params.kind === "heartbeat") {
          return { status: "skipped", reason: "active-run" };
        }
        const followupAdmission = await waitForReplyRunFollowupAdmission(
          params.sessionKey,
          baseWaitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          { signal: params.upstreamAbortSignal },
        );
        if (!followupAdmission.settled) {
          return {
            status: "skipped",
            reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          };
        }
        sessionId = followupAdmission.sessionId ?? sessionId;
        continue;
      }
      if (!(error instanceof ReplyRunAlreadyActiveError)) {
        throw error;
      }
      const activeOperation = replyRunRegistry.get(params.sessionKey);
      if (params.kind === "heartbeat" || params.kind === "control_abort") {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      // Visible and queued turns may wait for active runs; control turns must stay immediate.
      if (params.waitForActive === false) {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      // A healthy active run makes a visible turn queue behind it indefinitely.
      // A superseded run whose abort was already signalled is being torn down;
      // it must not block a newer visible turn forever if teardown never reaches
      // completion and leaves the lane wedged until restart clears memory.
      const activeRunSuperseded = activeOperation?.abortSignal.aborted === true;
      const activeRunWaitTimeoutMs =
        baseWaitTimeoutMs ?? (activeRunSuperseded ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
      const ended = await replyRunRegistry.waitForIdle(params.sessionKey, activeRunWaitTimeoutMs, {
        signal: params.upstreamAbortSignal,
      });
      if (!ended) {
        if (isAbortSignalAborted(params.upstreamAbortSignal)) {
          return { status: "skipped", reason: "aborted", activeOperation };
        }
        // If the still-active run was already superseded and failed to release
        // its lane, force-clear the dead operation so this visible turn can
        // take over. Healthy active runs remain protected.
        if (activeOperation && activeOperation.abortSignal.aborted) {
          sessionId = activeOperation.sessionId;
          activeOperation.fail("run_failed");
          continue;
        }
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      if (activeOperation) {
        sessionId = activeOperation.sessionId;
      }
    }
  }
}

/** Resolves the default turn kind from reply options. */
export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
