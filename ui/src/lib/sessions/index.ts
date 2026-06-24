import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewayEventFrame } from "../../api/gateway.ts";
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

export type SessionSnapshot = {
  result: SessionsListResult | null;
  loading: boolean;
  error: string | null;
};

export type SessionListOptions = {
  agentId?: string;
  search?: string;
  offset?: number;
  limit?: number;
};

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

export type SessionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

export type SessionCapability = {
  readonly snapshot: SessionSnapshot;
  list: (options?: SessionListOptions) => Promise<SessionsListResult | null>;
  refresh: (options?: { agentId?: string; force?: boolean }) => Promise<void>;
  create: (params?: {
    agentId?: string;
    parentSessionKey?: string;
    emitCommandHooks?: boolean;
  }) => Promise<string | null>;
  subscribe: (listener: (snapshot: SessionSnapshot) => void) => () => void;
  dispose: () => void;
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
      row.kind !== "cron" &&
      !isCronSessionKey(row.key) &&
      !isSubagentSessionKey(row.key) &&
      !row.spawnedBy &&
      (!options.filterByAgent ||
        isSessionKeyTiedToAgent(row.key, options.agentId, options.defaultAgentId))
    );
  });
}

const SESSION_LIST_PARAMS = {
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
} as const;

function isSessionEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed" || event.event === "session.operation";
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

export function resolveSessionCreateParams(
  sessionKey: string,
  agentId: string,
  options: { emitCommandHooksWithoutParent?: boolean } = {},
) {
  const normalizedSessionKey = sessionKey.trim();
  const parentSessionKey =
    normalizedSessionKey && normalizedSessionKey.toLowerCase() !== "unknown"
      ? normalizedSessionKey
      : undefined;
  return {
    agentId,
    ...(parentSessionKey ? { parentSessionKey, emitCommandHooks: true } : {}),
    ...(parentSessionKey === undefined && options.emitCommandHooksWithoutParent !== undefined
      ? { emitCommandHooks: options.emitCommandHooksWithoutParent }
      : {}),
  };
}

export function createSessionCapability(gateway: SessionGateway): SessionCapability {
  let snapshot: SessionSnapshot = {
    result: null,
    loading: false,
    error: null,
  };
  let inFlight: Promise<void> | null = null;
  let queuedRefresh: { agentId?: string; force?: boolean } | null = null;
  let disposed = false;
  const listeners = new Set<(next: SessionSnapshot) => void>();

  const requestList = async (
    options: SessionListOptions = {},
  ): Promise<SessionsListResult | null> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return null;
    }
    const params: Record<string, unknown> = {
      ...SESSION_LIST_PARAMS,
      limit: options.limit ?? 50,
    };
    const agentId = options.agentId?.trim();
    const search = options.search?.trim();
    if (agentId) {
      params.agentId = agentId;
    }
    if (search) {
      params.search = search;
    }
    if (typeof options.offset === "number" && options.offset > 0) {
      params.offset = Math.floor(options.offset);
    }
    const result = await client.request<SessionsListResult | undefined>("sessions.list", params);
    return disposed || gateway.snapshot.client !== client ? null : (result ?? null);
  };

  const publish = (next: SessionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const load = async (options: { agentId?: string; force?: boolean }) => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return;
    }
    publish({ ...snapshot, loading: true, error: null });
    try {
      const result = await requestList({ agentId: options.agentId });
      if (disposed || gateway.snapshot.client !== client) {
        return;
      }
      publish({ result, loading: false, error: null });
    } catch (error) {
      if (!disposed && gateway.snapshot.client === client) {
        publish({ ...snapshot, loading: false, error: String(error) });
      }
    }
  };

  const refresh = (options: { agentId?: string; force?: boolean } = {}) => {
    if (!gateway.snapshot.connected || !gateway.snapshot.client || disposed) {
      return Promise.resolve();
    }
    if (inFlight) {
      queuedRefresh = options;
      return inFlight;
    }
    if (snapshot.result && !options.force) {
      return Promise.resolve();
    }
    const request = load(options).finally(() => {
      inFlight = null;
      const queued = queuedRefresh;
      queuedRefresh = null;
      if (queued) {
        void refresh({ ...queued, force: true });
      }
    });
    inFlight = request;
    return request;
  };

  const create = async (
    params: {
      agentId?: string;
      parentSessionKey?: string;
      emitCommandHooks?: boolean;
    } = {},
  ) => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || snapshot.loading || disposed) {
      return null;
    }
    try {
      const result = await client.request<{ key?: unknown }>("sessions.create", params);
      const key = typeof result?.key === "string" ? result.key.trim() : "";
      if (!key) {
        throw new Error("sessions.create returned no key");
      }
      await refresh({ agentId: params.agentId, force: true });
      return key;
    } catch (error) {
      publish({ ...snapshot, error: String(error) });
      return null;
    }
  };

  const stopGateway = gateway.subscribe((next) => {
    if (!next.connected || !next.client) {
      publish({ result: null, loading: false, error: null });
      return;
    }
    void refresh();
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (isSessionEvent(event)) {
      void refresh({ force: true });
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    list: requestList,
    refresh,
    create,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      stopGateway();
      stopEvents();
      listeners.clear();
      inFlight = null;
      queuedRefresh = null;
    },
  };
}
