import type { GatewayEventFrame } from "../api/gateway.ts";
import type { GatewayHelloOk, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { isCronSessionKey } from "../lib/session-display.ts";
import {
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../lib/session-key.ts";
import type { ApplicationGateway } from "./context.ts";

export type ApplicationSessionsSnapshot = {
  result: SessionsListResult | null;
  loading: boolean;
  error: string | null;
};

export type ApplicationSessionListOptions = {
  agentId?: string;
  search?: string;
  offset?: number;
  limit?: number;
};

export type ApplicationSessionNavigationInput = {
  result: SessionsListResult | null;
  sessionKey: string;
  assistantAgentId?: string | null;
  hello?: GatewayHelloOk | null;
};

export type ApplicationSessionNavigation = {
  currentSessionKey: string;
  selectedAgentId: string;
  defaultAgentId: string;
  selectedSession?: GatewaySessionRow;
  recentSessions: GatewaySessionRow[];
};

export type ApplicationSessions = {
  readonly snapshot: ApplicationSessionsSnapshot;
  list: (options?: ApplicationSessionListOptions) => Promise<SessionsListResult | null>;
  refresh: (options?: { agentId?: string; force?: boolean }) => Promise<void>;
  create: (params?: {
    agentId?: string;
    parentSessionKey?: string;
    emitCommandHooks?: boolean;
  }) => Promise<string | null>;
  subscribe: (listener: (snapshot: ApplicationSessionsSnapshot) => void) => () => void;
  dispose: () => void;
};

const SESSION_LIST_PARAMS = {
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
} as const;

function isSessionEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed" || event.event === "session.operation";
}

export function resolveApplicationSessionNavigation(
  input: ApplicationSessionNavigationInput,
): ApplicationSessionNavigation {
  const currentSessionKey = input.sessionKey.trim();
  const defaultAgentId = resolveUiSelectedGlobalAgentId({
    assistantAgentId: input.assistantAgentId,
    hello: input.hello,
  });
  const selectedAgentId = parseAgentSessionKey(currentSessionKey)?.agentId ?? defaultAgentId;
  const shouldFilterByAgent = currentSessionKey.toLowerCase() !== "unknown";
  const recentSessions = (input.result?.sessions ?? [])
    .filter(
      (row) =>
        !row.archived &&
        row.kind !== "global" &&
        row.kind !== "unknown" &&
        row.kind !== "cron" &&
        !isCronSessionKey(row.key) &&
        !isSubagentSessionKey(row.key) &&
        !row.spawnedBy &&
        (!shouldFilterByAgent || isSessionKeyTiedToAgent(row.key, selectedAgentId, defaultAgentId)),
    )
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

export function createApplicationSessions(gateway: ApplicationGateway): ApplicationSessions {
  let snapshot: ApplicationSessionsSnapshot = {
    result: null,
    loading: false,
    error: null,
  };
  let inFlight: Promise<void> | null = null;
  let queuedRefresh: { agentId?: string; force?: boolean } | null = null;
  let disposed = false;
  const listeners = new Set<(next: ApplicationSessionsSnapshot) => void>();

  const requestList = async (
    options: ApplicationSessionListOptions = {},
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

  const publish = (next: ApplicationSessionsSnapshot) => {
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
