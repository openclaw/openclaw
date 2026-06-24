import type { GatewayHelloOk, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { isCronSessionKey } from "../session-display.ts";
import {
  isUiGlobalSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiDefaultAgentId,
  resolveUiGlobalAliasAgentId,
  resolveUiKnownSelectedGlobalAgentId,
  resolveUiSelectedGlobalAgentId,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
export type SessionNavigationInput = {
  result: SessionsListResult | null;
  sessionKey: string;
  assistantAgentId?: string | null;
  hello?: GatewayHelloOk | null;
};

export type SessionNavigation = {
  currentSessionKey: string;
  selectedAgentId: string;
  defaultAgentId: string;
  selectedSession?: GatewaySessionRow;
  recentSessions: GatewaySessionRow[];
};

export type SessionScopeHost = {
  assistantAgentId?: string | null;
  agentsList?: {
    defaultId?: string | null;
    mainKey?: string | null;
    agents?: Array<{ id: string }>;
  } | null;
  hello: GatewayHelloOk | null;
};

export type SessionScopeHostWithKey = SessionScopeHost & {
  sessionKey: string;
};

function readHelloDefaultAgentId(host: Pick<SessionScopeHost, "hello">): string | undefined {
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return snapshot?.sessionDefaults?.defaultAgentId?.trim() || undefined;
}

export function scopedAgentIdForSession(
  host: SessionScopeHost,
  sessionKey: string | undefined | null,
): string | undefined {
  return isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : (resolveUiGlobalAliasAgentId(host, sessionKey) ?? undefined);
}

export function scopedAgentParamsForSession(
  host: SessionScopeHost,
  sessionKey: string,
): { agentId?: string } {
  const agentId = isUiGlobalSessionKey(sessionKey)
    ? resolveUiKnownSelectedGlobalAgentId(host)
    : resolveUiGlobalAliasAgentId(host, sessionKey);
  return agentId ? { agentId: normalizeAgentId(agentId) } : {};
}

export function scopedAgentListParamsForSession(
  host: SessionScopeHost,
  sessionKey: string,
): { agentId?: string } {
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

export function visibleSessionMatches(
  host: SessionScopeHostWithKey,
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
      ? normalizeAgentId(hostAliasAgentId) === normalizeAgentId(expectedAgentId)
      : normalizeAgentId(hostAliasAgentId) === resolveUiDefaultAgentId(host);
  }
  if (!isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  const selectedAgentId = resolveUiKnownSelectedGlobalAgentId(host);
  const expectedAgentId = agentId
    ? normalizeAgentId(agentId)
    : host.agentsList?.defaultId
      ? normalizeAgentId(host.agentsList.defaultId)
      : readHelloDefaultAgentId(host);
  return expectedAgentId
    ? normalizeAgentId(selectedAgentId ?? "") === normalizeAgentId(expectedAgentId)
    : selectedAgentId === undefined;
}

export function getVisibleSessionRows(
  result: SessionsListResult | null,
  options: {
    currentSessionKey?: string;
    agentId: string;
    defaultAgentId: string;
    filterByAgent?: boolean;
    hideCron?: boolean;
  },
): GatewaySessionRow[] {
  return (result?.sessions ?? []).filter((row) => {
    if (row.key === options.currentSessionKey) {
      return true;
    }
    return (
      !row.archived &&
      row.kind !== "global" &&
      row.kind !== "unknown" &&
      (options.hideCron === false || (row.kind !== "cron" && !isCronSessionKey(row.key))) &&
      !isSubagentSessionKey(row.key) &&
      !row.spawnedBy &&
      (!options.filterByAgent ||
        isSessionKeyTiedToAgent(row.key, options.agentId, options.defaultAgentId))
    );
  });
}

export function resolveSessionNavigation(input: SessionNavigationInput): SessionNavigation {
  const currentSessionKey = input.sessionKey.trim();
  const defaultAgentId = resolveUiSelectedGlobalAgentId({
    assistantAgentId: input.assistantAgentId,
    hello: input.hello,
  });
  const selectedAgentId = parseAgentSessionKey(currentSessionKey)?.agentId ?? defaultAgentId;
  const shouldFilterByAgent = currentSessionKey.toLowerCase() !== "unknown";
  const recentSessions = getVisibleSessionRows(input.result, {
    currentSessionKey: currentSessionKey || undefined,
    agentId: selectedAgentId,
    defaultAgentId,
    filterByAgent: shouldFilterByAgent,
  })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5);
  return {
    currentSessionKey,
    selectedAgentId,
    defaultAgentId,
    selectedSession: input.result?.sessions.find((row) => row.key === currentSessionKey),
    recentSessions,
  };
}
