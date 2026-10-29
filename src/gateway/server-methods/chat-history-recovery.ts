import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
import { projectInFlightRunSnapshot } from "../chat-inflight-snapshot.js";
import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatRunState } from "../server-chat-state.js";
import type { RespondFn } from "./types.js";

export function resolveEmbeddedAgentRunRecoverySnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs" | "registry">;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
}) {
  const sessionId =
    params.sessionId ??
    resolveActiveEmbeddedRunHandleSessionId(params.canonicalSessionKey) ??
    resolveActiveEmbeddedRunHandleSessionId(params.requestedSessionKey);
  if (!sessionId) {
    return undefined;
  }
  const owner = resolveActiveEmbeddedRunOwner(sessionId);
  if (!owner) {
    return undefined;
  }
  // Queued execution has its own runtime ID; history must retain the client
  // identity used by its live events and final reply.
  const registration = params.chatRunState.registry.peek(owner.runId);
  const runId =
    registration &&
    (registration.sessionKey === params.requestedSessionKey ||
      registration.sessionKey === params.canonicalSessionKey) &&
    chatRunBelongsToSelectedAgent({
      agentId: registration.agentId,
      sessionKey: registration.sessionKey,
      selectedAgentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    })
      ? registration.clientRunId
      : owner.runId;
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId,
    startedAtMs: owner.startedAtMs,
    sessionAbortable: true,
  });
}

export type ChatHistoryMethod = "chat.history" | "chat.startup" | "chat.message.get";

export function respondChatHistoryUnavailable(
  method: ChatHistoryMethod,
  respond: RespondFn,
  message: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: { method },
      retryable: true,
      retryAfterMs: 250,
    }),
  );
}
