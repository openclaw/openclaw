import { t } from "../../i18n/index.ts";
import { loadCompleteChatHistory } from "../../lib/chat/complete-history.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { scopedAgentIdForSession } from "../../lib/sessions/index.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { exportChatMarkdown, type ChatExportResult } from "./export.ts";

type ChatExportHost = Pick<
  ChatPageHost,
  | "client"
  | "connected"
  | "sessionKey"
  | "currentSessionId"
  | "connectionEpoch"
  | "assistantName"
  | "hello"
> &
  Parameters<typeof scopedAgentIdForSession>[0];

export async function exportCurrentChat(
  host: ChatExportHost,
  isOwnerCurrent: () => boolean,
): Promise<ChatExportResult> {
  const { client, sessionKey, currentSessionId, connectionEpoch, assistantName, hello } = host;
  const agentId = scopedAgentIdForSession(host, sessionKey);
  const access = readSessionMethodAccess(
    { client, hello, phase: host.connected ? "connected" : "offline" },
    { method: "chat.history", requiredScope: "operator.read", sessionScope: true },
  );
  if (!access.allowed || !client) {
    throw new Error(access.allowed ? t("sessionsView.actionRequiresConnection") : access.reason);
  }
  const isCurrent = () =>
    isOwnerCurrent() &&
    host.connected &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.hello === hello &&
    host.sessionKey === sessionKey &&
    host.currentSessionId === currentSessionId &&
    scopedAgentIdForSession(host, sessionKey) === agentId;
  const messages = await loadCompleteChatHistory({
    client,
    sessionKey,
    sessionId: currentSessionId,
    agentId,
    isCurrent,
  });
  if (!isCurrent()) {
    throw new Error(t("sessionsView.copyTranscriptChanged"));
  }
  return exportChatMarkdown(messages, assistantName);
}
