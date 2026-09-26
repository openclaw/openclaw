import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { loadSessionEntry } from "../session-utils.js";
import { broadcastChatError } from "./chat-broadcast.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatAbortOrigin = "rpc" | "stop-command" | "placement-abandon";

export type ChatAbortSessionSnapshot = Result<
  Pick<
    ReturnType<typeof loadSessionEntry>,
    "cfg" | "storePath" | "entry" | "canonicalKey" | "agentId"
  >,
  unknown
>;

export type AbortedPartialSnapshot = ReturnType<typeof captureAbortedPartial>;

export function withAbortedPartialPersistenceWarning(
  error: ErrorShape,
  warning: string | undefined,
): ErrorShape {
  return warning ? { ...error, message: `${error.message} ${warning}` } : error;
}

export type QueuedCollectorAbortOutcome = Result<
  { aborted: boolean; runIds: string[]; warning?: string },
  ErrorShape
>;

export function withQueuedCollectorWarning(
  outcome: QueuedCollectorAbortOutcome,
  warning: string,
): QueuedCollectorAbortOutcome {
  return outcome.ok
    ? { ok: true, value: { ...outcome.value, warning } }
    : { ok: false, error: withAbortedPartialPersistenceWarning(outcome.error, warning) };
}

/** Retain a failed save when a later cancellation or terminal write also fails. */
export function abortedPartialPersistenceError(
  error: unknown,
  warning: string | undefined,
): unknown {
  if (!warning) {
    return error;
  }
  const message = `${formatErrorMessage(error)} ${warning}`;
  return error instanceof SessionMutationAuthorizationChangedError
    ? new SessionMutationAuthorizationChangedError({ ...error.error, message })
    : new Error(message, { cause: error });
}

/** Capture before signaling cancellation, without loading asynchronous transcript writers. */
export function captureAbortedPartial(params: {
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: ChatAbortOrigin;
  session?: ChatAbortSessionSnapshot;
  resolveTerminalProducer?: ChatAbortControllerEntry["resolveTerminalProducer"];
}) {
  const { runId, abortOrigin } = params;
  try {
    const session = params.session ?? {
      ok: true,
      value: loadSessionEntry(
        params.sessionKey,
        params.agentId ? { agentId: params.agentId } : undefined,
      ),
    };
    if (!session.ok) {
      throw session.error;
    }
    const { cfg, storePath, entry, canonicalKey, agentId } = session.value;
    if (entry?.sessionId !== params.sessionId) {
      throw new Error("Aborted partial transcript session changed before persistence");
    }
    const producer = params.resolveTerminalProducer?.();
    const settlement = {
      deferred: false,
      producer:
        producer?.sessionId === params.sessionId && producer.sessionKey === params.sessionKey
          ? producer
          : undefined,
    };
    // Snapshot the incarnation before signaling. Reset can keep the SID, and
    // the guarded writer rechecks both facts inside its commit transaction.
    return {
      runId,
      abortOrigin,
      ok: true,
      settlement,
      value: {
        sessionKey: canonicalKey,
        sessionId: params.sessionId,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision ?? null,
        agentId,
        storePath,
        cfg,
        message: params.text,
        createIfMissing: true,
        idempotencyKey: `${runId}:assistant`,
        abortMeta: { aborted: true, origin: abortOrigin, runId },
      },
    } as const;
  } catch (error) {
    // Preparation is fallible metadata I/O, never a prerequisite for cancellation.
    return { runId, abortOrigin, ok: false, error } as const;
  }
}

/** Transfer the fallback before cancellation can clear the producer's session slot. */
export function deferAbortedPartialPersistence(
  snapshot: AbortedPartialSnapshot | undefined,
  context: Pick<
    GatewayRequestContext,
    | "trackExecution"
    | "logGateway"
    | "broadcast"
    | "nodeSendToSession"
    | "agentRunSeq"
    | "getRuntimeConfig"
  >,
): void {
  if (!snapshot?.ok || snapshot.settlement.deferred || !snapshot.settlement.producer) {
    return;
  }
  try {
    snapshot.settlement.deferred = snapshot.settlement.producer.handoff((producerCompleted) =>
      context.trackExecution(async () => {
        await producerCompleted;
        let warning: string | undefined;
        try {
          const { persistAbortedPartial } = await import("./chat-transcript-persistence.js");
          warning = await persistAbortedPartial({ context, snapshot, producerSettled: true });
        } catch (error) {
          context.logGateway.warn(
            `chat.abort deferred transcript append failed: ${formatErrorMessage(error)}`,
          );
          warning = ABORTED_PARTIAL_PERSISTENCE_WARNING;
        }
        if (warning) {
          try {
            broadcastChatError({
              context,
              runId: snapshot.runId,
              sessionKey: snapshot.value.sessionKey,
              agentId: snapshot.value.agentId,
              errorMessage: warning,
            });
          } catch (error) {
            // Delivery failure cannot retain a finished producer's successor fence.
            context.logGateway.warn(
              `chat.abort persistence warning delivery failed: ${formatErrorMessage(error)}`,
            );
          }
        }
      }),
    );
  } catch (error) {
    // No handoff was accepted; the caller keeps its synchronous persistence path.
    context.logGateway.warn(`chat.abort producer handoff failed: ${formatErrorMessage(error)}`);
  }
}

export const ABORTED_PARTIAL_PERSISTENCE_WARNING =
  "Stopped, but a reply could not be saved to history. Copy any visible text before leaving this chat.";
