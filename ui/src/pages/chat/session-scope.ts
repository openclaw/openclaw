import type { ChatSessionRefreshTarget } from "../../lib/chat/chat-types.ts";
import {
  scopedAgentListParamsForSession,
  type SessionListOptions,
  type SessionScopeHost,
} from "../../lib/sessions/index.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export const CHAT_SESSIONS_ACTIVE_MINUTES = 0;
export const CHAT_SESSIONS_REFRESH_LIMIT = 50;

export function createChatSessionsLoadOverrides(
  _state: { sessionsShowArchived?: boolean },
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): SessionListOptions {
  const overrides: SessionListOptions = {
    activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    limit: CHAT_SESSIONS_REFRESH_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    showArchived: false,
    preserveSessionsViewResult: true,
  };
  const search = normalizeOptionalString(options.search ?? undefined);
  if (search) {
    overrides.search = search;
  }
  const offset =
    typeof options.offset === "number" && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0;
  if (offset > 0) {
    overrides.offset = offset;
  }
  if (options.append === true) {
    overrides.append = true;
  }
  return overrides;
}

export function scopedAgentListParamsForRefreshTarget(
  host: SessionScopeHost,
  target: ChatSessionRefreshTarget,
) {
  const agentId =
    normalizeOptionalString(target.agentId) ??
    scopedAgentListParamsForSession(host, target.sessionKey).agentId;
  return agentId ? { agentId } : {};
}
