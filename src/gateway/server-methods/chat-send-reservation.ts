import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  lookupSessionGoalOperation,
  SessionGoalOperationError,
} from "../../config/sessions/goals-operations.js";
import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { readPreRegisteredRun } from "./chat-abort-authorization.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession, PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText, normalizeUnknownChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createPendingChatSendReservationAccess(params: {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  key: string;
  runId: string;
  attemptId: string;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
}) {
  const read = () =>
    readPreRegisteredRun({
      key: params.key,
      entry: params.context.dedupe.get(params.key),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
  return {
    read,
    reserve: () => {
      const { context, request, session, attemptId } = params;
      context.dedupe.set(params.key, {
        ts: session.now,
        ok: true,
        requestIdentity: request.requestIdentity,
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
          ownerConnId: normalizeOptionalChatText(params.client?.connId),
          ownerDeviceId: normalizeOptionalChatText(params.client?.connect?.device?.id),
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
        pending?.runId === params.runId &&
        normalizeUnknownChatText(pending.payload.attemptId) === params.attemptId
      ) {
        params.context.dedupe.delete(params.key);
      }
    },
  };
}

/** Recheck synchronously at reservation: recovery lookups can yield to a competing request. */
export function inspectGoalChatSendRetry({
  request,
  session,
  respond,
  context,
  durableClaimAccepted,
  assertCurrent,
}: {
  request: NormalizedChatSendRequest;
  session: LoadedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  durableClaimAccepted?: boolean;
  assertCurrent?: () => void;
}) {
  assertCurrent?.();
  const { sessionKey, storePath, entry, clientRunId, pendingChatSendKey } = session;
  if (!request.goalOperation) {
    return { kind: "new" } as const;
  }
  try {
    const receipt = lookupSessionGoalOperation({
      sessionKey,
      storePath,
      agentId: session.agentId,
      expectedSessionId: entry?.sessionId ?? session.backingSessionId ?? clientRunId,
      operation: request.goalOperation,
    });
    if (receipt) {
      return { kind: "replay", receipt } as const;
    }
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (
      pending?.payload.goalFingerprint === request.goalOperation.requestFingerprint ||
      (!pending && !durableClaimAccepted && context.chatAbortControllers.has(clientRunId))
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
      pending ||
      durableClaimAccepted ||
      context.dedupe.has(`chat:${clientRunId}`) ||
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
