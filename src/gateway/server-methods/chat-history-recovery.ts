import {
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
import { projectInFlightRunSnapshot } from "../chat-abort.js";
import type { ChatRunState } from "../server-chat-state.js";

export function resolveEmbeddedAgentRunRecoverySnapshot(params: {
  chatRunState: Pick<ChatRunState, "resolveBuffer" | "runs">;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  sessionId?: string;
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
  return projectInFlightRunSnapshot({
    chatRunState: params.chatRunState,
    runId: owner.runId,
    startedAtMs: owner.startedAtMs,
    sessionAbortable: true,
  });
}
