// Decides whether an inbound turn may start, queue, or abort a reply run.
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  retainReplyOperationUntilComplete,
  runAfterReplyOperationClear,
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
      reason: "active-run" | "aborted" | "lifecycle-invalidated";
      activeOperation?: ReplyOperation;
      lifecycleAdmission?: SessionWorkAdmissionLease;
    };

class QueuedFollowupLifecycleInvalidatedError extends Error {}

const lifecycleAdmissionByOperation = new WeakMap<ReplyOperation, SessionWorkAdmissionLease>();

/** Runs owner work with its admission marked as the initiating lifecycle context. */
export async function runWithReplyOperationLifecycleAdmission<T>(
  operation: ReplyOperation | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const admission = operation ? lifecycleAdmissionByOperation.get(operation) : undefined;
  return admission ? await admission.run(run) : await run();
}

function rejectLifecycleInvalidatedWork(params: { kind: ReplyTurnKind; message: string }): never {
  if (params.kind === "queued_followup") {
    throw new QueuedFollowupLifecycleInvalidatedError(params.message);
  }
  throw new Error(params.message);
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Waits for or claims the per-session reply run slot. */
export async function admitReplyTurn(params: {
  sessionKey: string;
  sessionId: string;
  expectedSessionId?: string;
  expectedActiveOperation?: ReplyOperation;
  storePath?: string;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  upstreamAbortSignal?: AbortSignal;
  waitTimeoutMs?: number;
  waitForActive?: boolean;
  retainLifecycleAdmissionOnActive?: boolean;
  onLifecycleInterrupt?: () => void;
}): Promise<ReplyTurnAdmission> {
  let sessionId = params.sessionId;
  let expectedSessionId = params.expectedSessionId;
  const waitTimeoutMs =
    params.waitTimeoutMs ??
    (params.kind === "queued_followup" ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS : undefined);
  while (true) {
    if (isAbortSignalAborted(params.upstreamAbortSignal)) {
      return { status: "skipped", reason: "aborted" };
    }
    try {
      const storePath = params.storePath;
      let operation: ReplyOperation | undefined;
      let interruptedBeforeOperation = false;
      const admission = storePath
        ? await beginSessionWorkAdmission({
            scope: storePath,
            identities: [params.sessionKey],
            signal: params.upstreamAbortSignal,
            onInterrupt: () => {
              interruptedBeforeOperation = true;
              operation?.abortForRestart();
              params.onLifecycleInterrupt?.();
            },
            assertAllowed: () => {
              const currentEntry = loadSessionEntry({
                storePath,
                sessionKey: params.sessionKey,
                readConsistency: "latest",
              });
              if (expectedSessionId && !currentEntry) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: `Session "${params.sessionKey}" was deleted while starting work. Retry.`,
                });
              }
              const registeredOperation = replyRunRegistry.get(params.sessionKey);
              const rotationOperation = [registeredOperation, params.expectedActiveOperation].find(
                (candidate) => {
                  if (
                    !candidate ||
                    !expectedSessionId ||
                    currentEntry?.sessionId !== candidate.sessionId ||
                    !candidate.hasOwnedSessionId(expectedSessionId)
                  ) {
                    return false;
                  }
                  if (
                    candidate.result?.kind === "aborted" &&
                    candidate.result.code === "aborted_for_restart"
                  ) {
                    return false;
                  }
                  return candidate === registeredOperation || candidate.result !== null;
                },
              );
              const activeOperationRotatedExpectedSession = Boolean(
                rotationOperation && currentEntry?.sessionId === rotationOperation.sessionId,
              );
              if (
                expectedSessionId &&
                currentEntry?.sessionId !== expectedSessionId &&
                !activeOperationRotatedExpectedSession
              ) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
                });
              }
              if (activeOperationRotatedExpectedSession) {
                expectedSessionId = currentEntry?.sessionId;
              }
              const archivedSessionError = resolveSessionWorkStartError(
                params.sessionKey || sessionId,
                currentEntry,
              );
              if (archivedSessionError) {
                rejectLifecycleInvalidatedWork({
                  kind: params.kind,
                  message: archivedSessionError,
                });
              }
              sessionId = currentEntry?.sessionId ?? sessionId;
            },
          })
        : undefined;
      if (interruptedBeforeOperation) {
        admission?.release();
        rejectLifecycleInvalidatedWork({
          kind: params.kind,
          message: `Session "${params.sessionKey}" changed while starting work. Retry.`,
        });
      }
      try {
        operation = createReplyOperation({
          sessionKey: params.sessionKey,
          sessionId,
          resetTriggered: params.resetTriggered,
          routeThreadId: params.routeThreadId,
          upstreamAbortSignal: params.upstreamAbortSignal,
          respectFollowupAdmissionBarrier:
            params.kind === "queued_followup" || params.kind === "heartbeat",
        });
      } catch (error) {
        if (
          error instanceof ReplyRunAlreadyActiveError &&
          admission &&
          params.retainLifecycleAdmissionOnActive
        ) {
          return {
            status: "skipped",
            reason: "active-run",
            activeOperation: replyRunRegistry.get(params.sessionKey),
            lifecycleAdmission: admission,
          };
        }
        admission?.release();
        throw error;
      }
      if (admission) {
        // The lifecycle fence follows hooks, media work, agent execution, and
        // final delivery. Reset/delete interrupts the operation and waits until
        // its actual owner clears it before mutating the persisted session.
        retainReplyOperationUntilComplete(operation);
        lifecycleAdmissionByOperation.set(operation, admission);
        runAfterReplyOperationClear(operation, () => {
          lifecycleAdmissionByOperation.delete(operation);
          admission.release();
        });
      }
      return {
        status: "owned",
        operation,
      };
    } catch (error) {
      if (isAbortSignalAborted(params.upstreamAbortSignal)) {
        return { status: "skipped", reason: "aborted" };
      }
      if (error instanceof QueuedFollowupLifecycleInvalidatedError) {
        return { status: "skipped", reason: "lifecycle-invalidated" };
      }
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
        if (expectedSessionId && followupAdmission.sessionId) {
          expectedSessionId = followupAdmission.sessionId;
        }
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
      const ended = await replyRunRegistry.waitForIdle(params.sessionKey, waitTimeoutMs, {
        signal: params.upstreamAbortSignal,
      });
      if (!ended) {
        return {
          status: "skipped",
          reason: isAbortSignalAborted(params.upstreamAbortSignal) ? "aborted" : "active-run",
          activeOperation,
        };
      }
      if (activeOperation) {
        sessionId = activeOperation.sessionId;
        // In-lane compaction may rotate the active operation's persisted ID.
        // Lifecycle reset aborts use a distinct result and must stay invalidated.
        if (
          expectedSessionId &&
          !(
            activeOperation.result?.kind === "aborted" &&
            activeOperation.result.code === "aborted_for_restart"
          )
        ) {
          expectedSessionId = activeOperation.sessionId;
        }
      }
    }
  }
}

/** Resolves the default turn kind from reply options. */
export function resolveReplyTurnKind(opts?: { isHeartbeat?: boolean }): ReplyTurnKind {
  return opts?.isHeartbeat === true ? "heartbeat" : "visible";
}
