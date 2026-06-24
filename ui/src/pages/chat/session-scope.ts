import type { GatewayHelloOk } from "../../api/gateway.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
} from "../../lib/session-key.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../lib/string-coerce.ts";
import type { LoadSessionsOverrides } from "../sessions/data.ts";
import type { ChatSessionRefreshTarget } from "./types.ts";

export type ChatAgentScopeHost = {
  assistantAgentId?: string | null;
  agentsList?: {
    defaultId?: string | null;
    mainKey?: string | null;
    agents?: Array<{ id: string }>;
  } | null;
  hello: GatewayHelloOk | null;
};

export type ChatSessionScopeHost = ChatAgentScopeHost & {
  sessionKey: string;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 0;
export const CHAT_SESSIONS_REFRESH_LIMIT = 50;

export function createChatSessionsLoadOverrides(
  _state: { sessionsShowArchived?: boolean },
  options: { offset?: number; append?: boolean; search?: string | null } = {},
): LoadSessionsOverrides {
  const overrides: LoadSessionsOverrides = {
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

function readHelloDefaultAgentId(host: Pick<ChatAgentScopeHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

export function scopedAgentIdForSession(
  host: ChatAgentScopeHost,
  sessionKey: string | undefined | null,
) {
  return isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : (resolveUiGlobalAliasAgentId(host, sessionKey) ?? undefined);
}

export function visibleSessionMatches(
  host: ChatSessionScopeHost,
  sessionKey: string,
  agentId: string | undefined,
): boolean {
  if (host.sessionKey !== sessionKey) {
    const hostAliasAgentId = resolveUiGlobalAliasAgentId(host, host.sessionKey);
    if (!hostAliasAgentId || !isUiGlobalSessionKey(sessionKey)) {
      return false;
    }
    const expectedAgentId = agentId ?? host.agentsList?.defaultId ?? readHelloDefaultAgentId(host);
    return expectedAgentId
      ? hostAliasAgentId === normalizeAgentId(expectedAgentId)
      : hostAliasAgentId === normalizeAgentId("main");
  }
  if (!isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const selectedAgentId = resolveUiKnownSelectedGlobalAgentId(host);
  const expectedAgentId = agentId ?? host.agentsList?.defaultId ?? readHelloDefaultAgentId(host);
  return expectedAgentId
    ? selectedAgentId === normalizeAgentId(expectedAgentId)
    : selectedAgentId === undefined;
}

export function scopedAgentParamsForSession(host: ChatAgentScopeHost, sessionKey: string) {
  const agentId = isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : resolveUiGlobalAliasAgentId(host, sessionKey);
  return agentId ? { agentId } : {};
}

export function scopedAgentListParamsForSession(host: ChatAgentScopeHost, sessionKey: string) {
  const parsed = parseAgentSessionKey(sessionKey);
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const agentId =
    parsed?.agentId ??
    (normalizedSessionKey === "global"
      ? resolveUiKnownSelectedGlobalAgentId(host)
      : normalizedSessionKey === "unknown"
        ? undefined
        : resolveUiDefaultAgentId(host));
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export function scopedAgentListParamsForRefreshTarget(
  host: ChatAgentScopeHost,
  target: ChatSessionRefreshTarget,
) {
  const agentId =
    normalizeOptionalString(target.agentId) ??
    scopedAgentListParamsForSession(host, target.sessionKey).agentId;
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}
