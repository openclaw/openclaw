import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { setChatError } from "./chat-history-state.ts";
import {
  formatTerminalChatSendAckError,
  isTerminalFailureChatSendAck,
  normalizeChatSendAck,
} from "./chat-send-ack.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

/**
 * Try again asks the Gateway to continue the failed run with hidden input. The notice
 * hides at once; the Gateway's history projection keeps it hidden after reload.
 */
export async function retryFailedChatRun(host: ChatPageHost, runId: string): Promise<void> {
  const { client, sessionKey } = host;
  const sessionId = host.currentSessionId ?? selectedChatSessionRow(host)?.sessionId;
  if (!client) {
    return;
  }
  const agentId = resolveUiSelectedSessionAgentId(host);
  const idempotencyKey = generateUUID();
  const isCurrent = () => host.client === client && host.sessionKey === sessionKey;
  host.chatRetriedRunId = runId;
  try {
    const ack = normalizeChatSendAck(
      await client.request("chat.retry", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
        runId,
        idempotencyKey,
      }),
      idempotencyKey,
    );
    if (isTerminalFailureChatSendAck(ack)) {
      throw new Error(formatTerminalChatSendAckError(ack, "chat"));
    }
    if (isCurrent()) {
      adoptStartedChatRun(host, ack.runId, Date.now());
    }
  } catch (error) {
    // A newer retry owns the optimistic notice state; only this attempt may restore it.
    if (isCurrent() && host.chatRetriedRunId === runId) {
      host.chatRetriedRunId = null;
      setChatError(host, formatUiError(error));
    }
  }
}
