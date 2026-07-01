import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  type SessionCapability,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { loadChatHistory, type ChatState } from "./chat-gateway.ts";
import type { ChatHost } from "./chat-send.ts";
import { reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { clearChatMessagesFromCache } from "./session-message-cache.ts";

const CHAT_SESSION_LIST_ACTIVE_MINUTES = 0;
const CHAT_SESSION_LIST_LIMIT = 50;

type ChatSessionListHost = {
  sessionsShowArchived?: boolean;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

export function buildChatSessionListOptions(
  _state: ChatSessionListHost,
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const result: SessionListOptions = {
    activeMinutes: CHAT_SESSION_LIST_ACTIVE_MINUTES,
    limit: CHAT_SESSION_LIST_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    showArchived: false,
  };
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    result.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    result.offset = offset;
  }
  if (options.append === true) {
    result.append = true;
  }
  return result;
}

export function refreshCurrentChatSessionList(host: ChatSessionRefreshHost): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForSession(host, host.sessionKey),
    force: true,
  });
}

export function refreshChatSessionListForTarget(
  host: ChatSessionListHost &
    SessionScopeHost & {
      sessions: Pick<SessionCapability, "refresh">;
    },
  target: SessionRefreshTarget,
): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForRefreshTarget(host, target),
    force: true,
  });
}

function setChatError(host: ChatHost, error: string | null) {
  host.lastError = error;
  host.chatError = error;
}

function hasAbortableChatSessionRun(
  host: Pick<ChatHost, "chatRunId" | "sessionKey" | "sessionsResult">,
): boolean {
  if (host.chatRunId) {
    return true;
  }
  return Boolean(
    host.sessionsResult?.sessions.some(
      (session) => session.key === host.sessionKey && isSessionRunActive(session),
    ),
  );
}

function clearCachedChatMessagesForSession(host: ChatHost, sessionKey: string) {
  if (!host.chatMessagesBySession) {
    return;
  }
  clearChatMessagesFromCache(host.chatMessagesBySession, host, { sessionKey });
}

export async function clearChatHistory(host: ChatHost) {
  if (!host.client || !host.connected) {
    return;
  }
  const hadActiveRun = hasAbortableChatSessionRun(host);
  try {
    await host.sessions.reset(host.sessionKey, {
      agentId: scopedAgentParamsForSession(host, host.sessionKey).agentId,
    });
    host.chatMessages = [];
    clearCachedChatMessagesForSession(host, host.sessionKey);
    host.chatSideResult = null;
    host.chatReplyTarget = null;
    reconcileChatRunLifecycle(host as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      outcome: hadActiveRun ? "interrupted" : undefined,
      sessionStatus: "killed",
      runId: host.chatRunId,
      sessionKey: host.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      clearSideResultTerminalRuns: true,
      clearRunStatus: !hadActiveRun,
    });
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    setChatError(host, String(err));
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}
