import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "../server-shared.js";
import { readPreRegisteredRun } from "./chat-abort-authorization.js";
import type { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createPendingChatSendReservationAccess(params: {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  attemptId: string;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
}) {
  const { pendingChatSendKey: key, clientRunId: runId } = params.session;
  const read = () =>
    readPreRegisteredRun({
      key,
      entry: params.context.dedupe.get(key),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  return {
    read,
    reserve: () => {
      const { context, request, session, attemptId } = params;
      context.dedupe.set(key, {
        ts: session.now,
        ok: true,
        requestIdentity: request.goalOperation?.requestFingerprint ?? request.requestIdentity,
        payload: {
          runId: session.clientRunId,
          attemptId,
          status: "accepted",
          sessionKey: session.sessionKey,
          ...(session.backingSessionId ? { sessionId: session.backingSessionId } : {}),
          ...(session.rawSessionKey === session.sessionKey
            ? {}
            : { sessionKeyAliases: [session.rawSessionKey] }),
          ...(session.selectedAgent.agentId ? { agentId: session.selectedAgent.agentId } : {}),
          ownerConnId: normalizeOptionalString(params.client?.connId),
          ownerDeviceId: normalizeOptionalString(params.client?.connect?.device?.id),
          expiresAtMs: resolveChatRunExpiresAtMs({
            now: session.now,
            timeoutMs: session.timeoutMs,
          }),
          turnKind: request.turnKind,
          ...(request.goalOperation
            ? { goalFingerprint: request.goalOperation.requestFingerprint }
            : {}),
        },
      });
    },
    clear: () => {
      const pending = read();
      if (
        pending?.runId === runId &&
        normalizeOptionalString(pending.payload.attemptId) === params.attemptId
      ) {
        params.context.dedupe.delete(key);
      }
    },
  };
}

/** A retained request identity is not an ACK; only response-bearing rows may replay. */
export function readChatSendDedupeResponse(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
): DedupeEntry | undefined {
  const entry = dedupe.get(`chat:${runId}`);
  return entry?.requestIdentity &&
    entry.ok &&
    entry.payload === undefined &&
    entry.error === undefined
    ? undefined
    : entry;
}

/** Consume prepared receipts and current RAM ownership without yielding before reservation. */
export function inspectGoalChatSendRetry({
  request,
  session,
  respond,
  context,
  durableClaimAccepted,
  assertCurrent,
  prepared,
}: ChatSendPreAdmissionParams & {
  durableClaimAccepted?: boolean;
  prepared: Awaited<ReturnType<typeof prepareGoalChatSendRetry>>;
}) {
  assertCurrent?.();
  const { clientRunId, pendingChatSendKey } = session;
  if (!request.goalOperation) {
    return { kind: "new" } as const;
  }
  try {
    const receipt = prepared?.receipt;
    if (receipt instanceof SessionGoalOperationError) {
      throw receipt;
    }
    if (receipt) {
      return { kind: "replay", receipt } as const;
    }
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    const retainedIdentity = context.dedupe.get(`chat:${clientRunId}`)?.requestIdentity;
    const identityConflict =
      retainedIdentity !== undefined &&
      retainedIdentity !== request.goalOperation.requestFingerprint;
    const cachedResponse = readChatSendDedupeResponse(context.dedupe, clientRunId);
    // A completed admission may publish after the worker's receipt snapshot.
    const newlyPublishedResponse =
      retainedIdentity === request.goalOperation.requestFingerprint &&
      cachedResponse !== undefined &&
      cachedResponse !== prepared?.dedupe;
    if (
      !identityConflict &&
      (pending?.payload.goalFingerprint === request.goalOperation.requestFingerprint ||
        newlyPublishedResponse ||
        (!pending && !durableClaimAccepted && context.chatAbortControllers.has(clientRunId)))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Goal is being admitted; retry the same request.", {
          retryable: true,
        }),
      );
      return { kind: "settled" } as const;
    }
    if (
      identityConflict ||
      pending ||
      durableClaimAccepted ||
      cachedResponse ||
      context.chatRunState.hasAbortMarker(clientRunId) ||
      context.chatAbortControllers.has(clientRunId) ||
      context.chatQueuedTurns?.has(clientRunId)
    ) {
      throw new SessionGoalOperationError(
        "operation-conflict",
        "Goal operation ID is already used by another request.",
      );
    }
    return { kind: "new" } as const;
  } catch (error) {
    if (!(error instanceof SessionGoalOperationError)) {
      throw error;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
        details: { reason: `goal-${error.code}` },
      }),
    );
    return { kind: "settled" } as const;
  }
}
