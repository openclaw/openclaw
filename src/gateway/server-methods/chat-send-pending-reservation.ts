import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Publish the existing attempt-bound abort/retry reservation before lifecycle admission. */
export function writeChatSendPendingReservation(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  pendingAttemptId: string;
}) {
  const { request, session, client, context, pendingAttemptId } = params;
  const {
    now,
    clientRunId,
    pendingChatSendKey,
    sessionKey,
    backingSessionId,
    rawSessionKey,
    selectedAgent,
    timeoutMs,
  } = session;
  const { turnKind } = request;
  context.dedupe.set(pendingChatSendKey, {
    ts: now,
    ok: true,
    requestIdentity: request.requestIdentity,
    payload: {
      runId: clientRunId,
      attemptId: pendingAttemptId,
      status: "accepted" as const,
      sessionKey,
      ...(backingSessionId ? { sessionId: backingSessionId } : {}),
      ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
      ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
      ownerConnId: normalizeOptionalChatText(client?.connId),
      ownerDeviceId: normalizeOptionalChatText(client?.connect?.device?.id),
      expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      turnKind,
      ...(request.goalOperation
        ? { goalFingerprint: request.goalOperation.requestFingerprint }
        : {}),
    },
  });
}
