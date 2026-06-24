import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { resolveSessionCreateParams } from "./create.ts";
import {
  getVisibleSessionRows,
  resolveSessionNavigation,
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";

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

export {
  getVisibleSessionRows,
  resolveSessionNavigation,
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";
export { resolveSessionCreateParams } from "./create.ts";
export type {
  SessionNavigation,
  SessionNavigationInput,
  SessionScopeHost,
  SessionScopeHostWithKey,
} from "./navigation.ts";

const SESSION_LIST_PARAMS = {
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
} as const;

function isSessionEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed" || event.event === "session.operation";
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
