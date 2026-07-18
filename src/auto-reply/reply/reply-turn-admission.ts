// Decides whether an inbound turn may start, queue, or abort a reply run.
import {
  createReplyOperation,
  expireStaleReplyOperation,
  isReplyRunEvidenceStale,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  resolveReplyRunStaleThresholdMs,
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

function expireVisibleStaleOperation(operation: ReplyOperation | undefined): boolean {
  if (!operation) {
    return false;
  }
  const idleMs = Date.now() - operation.lastActivityAtMs;
  if (operation.result) {
    return (
      idleMs >= REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS &&
      expireStaleReplyOperation(operation, "terminal_unreleased")
    );
  }
  return isReplyRunEvidenceStale(operation) && expireStaleReplyOperation(operation, "no_activity");
}

function resolveVisibleActiveWaitMs(operation: ReplyOperation | undefined): number {
  if (!operation) {
    return REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS;
  }
  const ageMs = Date.now() - operation.lastActivityAtMs;
  const remainingMs = operation.result
    ? REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - ageMs
    : resolveReplyRunStaleThresholdMs(operation) - ageMs;
  return Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, Math.max(1, remainingMs));
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
  const waitTimeoutMs =
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
          waitTimeoutMs ?? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
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
      if (params.kind === "visible" && expireVisibleStaleOperation(activeOperation)) {
        continue;
      }
      if (params.kind === "heartbeat" || params.kind === "control_abort") {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      // Visible and queued turns may wait for active runs; control turns must stay immediate.
      if (params.waitForActive === false) {
        return { status: "skipped", reason: "active-run", activeOperation };
      }
      const activeWaitTimeoutMs =
        params.kind === "visible" ? resolveVisibleActiveWaitMs(activeOperation) : waitTimeoutMs;
      const ended = await replyRunRegistry.waitForIdle(params.sessionKey, activeWaitTimeoutMs, {
        signal: params.upstreamAbortSignal,
      });
      if (!ended) {
        if (params.kind === "visible" && !isAbortSignalAborted(params.upstreamAbortSignal)) {
          // Visible turns block on active work like before, but in bounded wait
          // slices: each wake reclaims the owner once it is provably stale,
          // otherwise loops back to keep waiting.
          const latestActiveOperation = replyRunRegistry.get(params.sessionKey);
          expireVisibleStaleOperation(latestActiveOperation ?? activeOperation);
          continue;
        }
        return {
          status: "skipped",
          reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          activeOperation,
        };
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
