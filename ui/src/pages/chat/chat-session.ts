import {
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
  type SessionCapability,
  type SessionListOptions,
  type SessionRefreshTarget,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

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

function buildChatSessionListOptions(
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
