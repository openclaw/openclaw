import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type {
  FastMode,
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsCompactionBranchResult,
  SessionsCompactionListResult,
  SessionsCompactionRestoreResult,
  SessionsListResult,
  SessionsPatchResult,
  SessionWorkspaceGetResult,
  SessionWorkspaceListResult,
} from "../../api/types.ts";
import { normalizeAgentId } from "../session-key.ts";
import { resolveSessionCreateParams } from "./create.ts";
import {
  filterSessionRows,
  getVisibleSessionRows,
  resolveSessionNavigation,
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";
import {
  reconcileSessionChanged,
  reconcileSessionHistory,
  type SessionReconcileOptions,
} from "./reconcile.ts";
export {
  buildSessionUsageDateParams,
  requestSessionUsage,
  requestSessionUsageLogs,
  requestSessionUsageTimeSeries,
} from "./usage.ts";
export type { SessionUsageQuery } from "./usage.ts";

export type SessionState = {
  result: SessionsListResult | null;
  agentId: string | null;
  loading: boolean;
  error: string | null;
  deletedKeys: readonly string[];
};

export type SessionListOptions = {
  agentId?: string;
  activeMinutes?: number;
  search?: string;
  offset?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  configuredAgentsOnly?: boolean;
  showArchived?: boolean;
  append?: boolean;
};

export type SessionCreateParams = {
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  emitCommandHooks?: boolean;
};

export type SessionPatch = {
  label?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  fastMode?: FastMode | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  archived?: boolean;
  pinned?: boolean;
};

export type SessionDeleteOptions = {
  agentId?: string;
  deleteTranscript?: boolean;
};

export type SessionDeleteTarget = {
  key: string;
  agentId?: string;
};

export type SessionDeleteBatchResult = {
  deleted: string[];
  errors: string[];
};

export type SessionCompactResult = {
  ok?: boolean;
  compacted?: boolean;
  reason?: string;
  result?: { tokensBefore?: number; tokensAfter?: number };
};

export type SessionSteerResult = {
  runId?: string;
  status?: unknown;
};

export type SessionResetOptions = {
  agentId?: string | null;
};

export type SessionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
  };
  subscribe: (listener: (snapshot: SessionGateway["snapshot"]) => void) => () => void;
  subscribeEvents: (listener: (event: GatewayEventFrame) => void) => () => void;
};

type SessionRequestClient = Pick<GatewayBrowserClient, "request">;

export type SessionMessageSubscription = {
  key: string;
  agentId?: string | null;
};

export type SessionCapability = {
  readonly state: SessionState;
  list: (options?: SessionListOptions) => Promise<SessionsListResult | null>;
  reconcile: (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions,
  ) => boolean;
  refresh: (options?: SessionListOptions & { force?: boolean }) => Promise<void>;
  create: (params?: SessionCreateParams) => Promise<string | null>;
  patch: (
    key: string,
    patch: SessionPatch,
    options?: { agentId?: string },
  ) => Promise<SessionsPatchResult | null>;
  delete: (key: string, options?: SessionDeleteOptions) => Promise<boolean>;
  deleteMany: (targets: readonly SessionDeleteTarget[]) => Promise<SessionDeleteBatchResult>;
  reset: (key: string, options?: SessionResetOptions) => Promise<void>;
  compact: (key: string, options?: { agentId?: string | null }) => Promise<SessionCompactResult>;
  steer: (
    key: string,
    message: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionSteerResult>;
  listFiles: (
    key: string,
    options?: { agentId?: string | null; path?: string; search?: string },
  ) => Promise<SessionWorkspaceListResult | null>;
  getFile: (
    key: string,
    path: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionWorkspaceGetResult | null>;
  subscribeMessages: (
    key: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionMessageSubscription>;
  unsubscribeMessages: (subscription: SessionMessageSubscription) => Promise<void>;
  listCheckpoints: (
    key: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionCompactionCheckpoint[]>;
  branchCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionBranchResult>;
  restoreCheckpoint: (
    key: string,
    checkpointId: string,
    options?: { agentId?: string | null },
  ) => Promise<SessionsCompactionRestoreResult>;
  subscribe: (listener: (state: SessionState) => void) => () => void;
  dispose: () => void;
};

export {
  filterSessionRows,
  getVisibleSessionRows,
  resolveSessionNavigation,
  scopedAgentIdForSession,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  visibleSessionMatches,
} from "./navigation.ts";
export { resolveSessionCreateParams } from "./create.ts";
export { reconcileSessionHistory } from "./reconcile.ts";
export type { SessionReconcileOptions } from "./reconcile.ts";
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

function buildSessionRequestParams(
  key: string,
  agentId?: string | null,
): { key: string; agentId?: string } {
  const normalizedKey = key.trim();
  const normalizedAgentId = agentId?.trim();
  return {
    key: normalizedKey,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
  };
}

function buildSessionListParams(options: SessionListOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...SESSION_LIST_PARAMS,
  };
  if (options.limit === undefined) {
    params.limit = 50;
  } else if (options.limit > 0) {
    params.limit = Math.floor(options.limit);
  }
  if (options.includeGlobal !== undefined) {
    params.includeGlobal = options.includeGlobal;
  }
  if (options.includeUnknown !== undefined) {
    params.includeUnknown = options.includeUnknown;
  }
  if (options.configuredAgentsOnly !== undefined) {
    params.configuredAgentsOnly = options.configuredAgentsOnly;
  }
  const activeMinutes =
    options.showArchived === true
      ? 0
      : typeof options.activeMinutes === "number" && options.activeMinutes > 0
        ? Math.floor(options.activeMinutes)
        : 0;
  if (activeMinutes > 0) {
    params.activeMinutes = activeMinutes;
  }
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
  return params;
}

export async function requestSessionList(
  client: SessionRequestClient,
  options: SessionListOptions = {},
): Promise<SessionsListResult | null> {
  const result = await client.request<SessionsListResult | undefined>(
    "sessions.list",
    buildSessionListParams(options),
  );
  return result ?? null;
}

export async function requestSessionCreate(
  client: SessionRequestClient,
  params: SessionCreateParams = {},
): Promise<string> {
  const result = await client.request<{ key?: unknown }>("sessions.create", params);
  const key = typeof result?.key === "string" ? result.key.trim() : "";
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  return key;
}

export function requestSessionPatch(
  client: SessionRequestClient,
  key: string,
  patch: SessionPatch,
  options: { agentId?: string | null } = {},
): Promise<SessionsPatchResult> {
  return client.request<SessionsPatchResult>("sessions.patch", {
    ...buildSessionRequestParams(key, options.agentId),
    ...patch,
  });
}

export function requestSessionDelete(
  client: SessionRequestClient,
  key: string,
  options: SessionDeleteOptions = {},
): Promise<{ deleted?: boolean }> {
  return client.request<{ deleted?: boolean }>("sessions.delete", {
    ...buildSessionRequestParams(key, options.agentId),
    deleteTranscript: options.deleteTranscript ?? true,
  });
}

export function requestSessionReset(
  client: SessionRequestClient,
  key: string,
  options: SessionResetOptions = {},
): Promise<void> {
  return client
    .request("sessions.reset", {
      ...buildSessionRequestParams(key, options.agentId),
    })
    .then(() => undefined);
}

export function requestSessionCompact(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionCompactResult> {
  return client.request<SessionCompactResult>("sessions.compact", {
    ...buildSessionRequestParams(key, options.agentId),
  });
}

export function requestSessionSteer(
  client: SessionRequestClient,
  key: string,
  message: string,
  options: { agentId?: string | null } = {},
): Promise<SessionSteerResult> {
  return client.request<SessionSteerResult>("sessions.steer", {
    ...buildSessionRequestParams(key, options.agentId),
    message,
  });
}

export function requestSessionFilesList(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null; path?: string; search?: string } = {},
): Promise<SessionWorkspaceListResult | null> {
  return client.request<SessionWorkspaceListResult | null>("sessions.files.list", {
    sessionKey: key,
    path: options.path ?? "",
    search: options.search ?? "",
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

export function requestSessionFile(
  client: SessionRequestClient,
  key: string,
  path: string,
  options: { agentId?: string | null } = {},
): Promise<SessionWorkspaceGetResult | null> {
  return client.request<SessionWorkspaceGetResult | null>("sessions.files.get", {
    sessionKey: key,
    path,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  });
}

export function subscribeSessionGateway(client: SessionRequestClient): Promise<void> {
  return client.request("sessions.subscribe", {}).then(() => undefined);
}

export async function subscribeSessionMessages(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionMessageSubscription> {
  const result = await client.request("sessions.messages.subscribe", {
    ...buildSessionRequestParams(key, options.agentId),
  });
  const subscribedKey =
    result && typeof result === "object" && typeof (result as { key?: unknown }).key === "string"
      ? (result as { key: string }).key.trim()
      : "";
  return {
    key: subscribedKey || key.trim(),
    agentId: options.agentId?.trim() || null,
  };
}

export function unsubscribeSessionMessages(
  client: SessionRequestClient,
  subscription: SessionMessageSubscription,
): Promise<void> {
  return client
    .request(
      "sessions.messages.unsubscribe",
      buildSessionRequestParams(subscription.key, subscription.agentId),
    )
    .then(() => undefined);
}

export async function listSessionCheckpoints(
  client: SessionRequestClient,
  key: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionListResult> {
  return client.request<SessionsCompactionListResult>(
    "sessions.compaction.list",
    buildSessionRequestParams(key, options.agentId),
  );
}

export function branchSessionCheckpoint(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionBranchResult> {
  return client.request<SessionsCompactionBranchResult>("sessions.compaction.branch", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

export function restoreSessionCheckpoint(
  client: SessionRequestClient,
  key: string,
  checkpointId: string,
  options: { agentId?: string | null } = {},
): Promise<SessionsCompactionRestoreResult> {
  return client.request<SessionsCompactionRestoreResult>("sessions.compaction.restore", {
    ...buildSessionRequestParams(key, options.agentId),
    checkpointId,
  });
}

function appendSessionResults(
  previous: SessionsListResult,
  page: SessionsListResult,
): SessionsListResult {
  const seen = new Set<string>();
  const sessions = [...previous.sessions, ...page.sessions].filter((row) => {
    if (!row.key || seen.has(row.key)) {
      return false;
    }
    seen.add(row.key);
    return true;
  });
  const totalCount = page.totalCount ?? previous.totalCount;
  const hasMore =
    page.hasMore ??
    (typeof totalCount === "number" && Number.isFinite(totalCount)
      ? sessions.length < totalCount
      : false);
  return {
    ...page,
    count: sessions.length,
    totalCount,
    hasMore,
    nextOffset: page.nextOffset ?? (hasMore ? sessions.length : null),
    sessions,
  };
}

function isSessionEvent(event: GatewayEventFrame): boolean {
  return event.event === "sessions.changed";
}

function canReconcileSessionEvent(options: SessionListOptions): boolean {
  return (
    options.activeMinutes === undefined &&
    options.search === undefined &&
    options.offset === undefined &&
    options.limit === undefined &&
    options.includeGlobal !== false &&
    options.includeUnknown !== false &&
    options.configuredAgentsOnly !== true
  );
}

export function createSessionCapability(gateway: SessionGateway): SessionCapability {
  let state: SessionState = {
    result: null,
    agentId: null,
    loading: false,
    error: null,
    deletedKeys: [],
  };
  let inFlight: Promise<void> | null = null;
  let queuedRefresh: (SessionListOptions & { force?: boolean }) | null = null;
  let disposed = false;
  let subscribedClient: GatewayBrowserClient | null = null;
  let lastListOptions: SessionListOptions = {};
  const listeners = new Set<(next: SessionState) => void>();

  const requestList = async (
    options: SessionListOptions = {},
  ): Promise<SessionsListResult | null> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return null;
    }
    const result = await requestSessionList(client, options);
    return disposed || gateway.snapshot.client !== client ? null : (result ?? null);
  };

  const publish = (next: SessionState) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const load = async (options: SessionListOptions & { force?: boolean }) => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return;
    }
    const { append: _append, force: _force, ...requestOptions } = options;
    lastListOptions = requestOptions;
    publish({ ...state, loading: true, error: null, deletedKeys: [] });
    try {
      const result = await requestList(options);
      if (disposed || gateway.snapshot.client !== client) {
        return;
      }
      const nextResult =
        result && options.append && options.offset && state.result
          ? appendSessionResults(state.result, result)
          : result;
      publish({
        result: nextResult,
        agentId: options.agentId?.trim() ? normalizeAgentId(options.agentId) : null,
        loading: false,
        error: null,
        deletedKeys: [],
      });
    } catch (error) {
      if (!disposed && gateway.snapshot.client === client) {
        publish({ ...state, loading: false, error: String(error), deletedKeys: [] });
      }
    }
  };

  const refresh = (options: SessionListOptions & { force?: boolean } = {}) => {
    if (!gateway.snapshot.connected || !gateway.snapshot.client || disposed) {
      return Promise.resolve();
    }
    if (inFlight) {
      queuedRefresh = options;
      return inFlight;
    }
    const hasListOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && value !== undefined,
    );
    if (state.result && !options.force && !hasListOverrides) {
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

  const create = async (params: SessionCreateParams = {}) => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || state.loading || disposed) {
      return null;
    }
    try {
      const key = await requestSessionCreate(client, params);
      if (disposed || gateway.snapshot.client !== client) {
        return null;
      }
      await refresh({ agentId: params.agentId, force: true });
      return key;
    } catch (error) {
      publish({ ...state, error: String(error) });
      return null;
    }
  };

  const patch = async (
    key: string,
    patchParams: SessionPatch,
    options: { agentId?: string } = {},
  ): Promise<SessionsPatchResult | null> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return null;
    }
    try {
      const result = await requestSessionPatch(client, key, patchParams, options);
      if (disposed || gateway.snapshot.client !== client) {
        return null;
      }
      await refresh({ agentId: options.agentId, force: true });
      return result;
    } catch (error) {
      publish({ ...state, error: String(error) });
      throw error;
    }
  };

  const reconcile = (
    row: GatewaySessionRow | undefined,
    defaults?: SessionsListResult["defaults"],
    options?: SessionReconcileOptions,
  ): boolean => {
    const result = reconcileSessionHistory(state.result, row, defaults, options);
    if (result === state.result) {
      return false;
    }
    publish({
      ...state,
      result,
      agentId: options?.resultAgentId?.trim()
        ? normalizeAgentId(options.resultAgentId)
        : state.agentId,
    });
    return true;
  };

  const remove = async (key: string, options: SessionDeleteOptions = {}): Promise<boolean> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return false;
    }
    try {
      await requestSessionDelete(client, key, options);
      if (disposed || gateway.snapshot.client !== client) {
        return false;
      }
      publish({ ...state, deletedKeys: [key] });
      await refresh({ agentId: options.agentId, force: true });
      return true;
    } catch (error) {
      publish({ ...state, error: String(error) });
      throw error;
    }
  };

  const removeMany = async (
    targets: readonly SessionDeleteTarget[],
  ): Promise<SessionDeleteBatchResult> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed || targets.length === 0) {
      return { deleted: [], errors: [] };
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const target of targets) {
      if (disposed || gateway.snapshot.client !== client) {
        break;
      }
      try {
        await requestSessionDelete(client, target.key, target);
        if (disposed || gateway.snapshot.client !== client) {
          break;
        }
        deleted.push(target.key);
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (deleted.length > 0 && !disposed && gateway.snapshot.client === client) {
      publish({ ...state, deletedKeys: deleted });
      await refresh({ force: true });
    }
    return { deleted, errors };
  };

  const reset = async (key: string, options: SessionResetOptions = {}): Promise<void> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return;
    }
    try {
      await requestSessionReset(client, key, options);
      if (disposed || gateway.snapshot.client !== client) {
        return;
      }
    } catch (error) {
      publish({ ...state, error: String(error) });
      throw error;
    }
  };

  const compact = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactResult> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      throw new Error("Session compaction requires an active Gateway connection");
    }
    const result = await requestSessionCompact(client, key, options);
    if (disposed || gateway.snapshot.client !== client) {
      throw new Error("Session compaction completed on a replaced Gateway client");
    }
    return result;
  };

  const steer = async (
    key: string,
    message: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionSteerResult> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      throw new Error("Session steering requires an active Gateway connection");
    }
    const result = await requestSessionSteer(client, key, message, options);
    if (disposed || gateway.snapshot.client !== client) {
      throw new Error("Session steering completed on a replaced Gateway client");
    }
    return result;
  };

  const listFiles = async (
    key: string,
    options: { agentId?: string | null; path?: string; search?: string } = {},
  ): Promise<SessionWorkspaceListResult | null> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return null;
    }
    const result = await requestSessionFilesList(client, key, options);
    return disposed || gateway.snapshot.client !== client ? null : result;
  };

  const getFile = async (
    key: string,
    path: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionWorkspaceGetResult | null> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return null;
    }
    const result = await requestSessionFile(client, key, path, options);
    return disposed || gateway.snapshot.client !== client ? null : result;
  };

  const subscribeMessages = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionMessageSubscription> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      throw new Error("Session message subscription requires an active Gateway connection");
    }
    const subscription = await subscribeSessionMessages(client, key, options);
    if (disposed || gateway.snapshot.client !== client) {
      throw new Error("Session message subscription completed on a replaced Gateway client");
    }
    return subscription;
  };

  const unsubscribeMessages = async (subscription: SessionMessageSubscription) => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return;
    }
    await unsubscribeSessionMessages(client, subscription);
  };

  const listCheckpoints = async (
    key: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionCompactionCheckpoint[]> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      return [];
    }
    const result = await listSessionCheckpoints(client, key, options);
    return disposed || gateway.snapshot.client !== client ? [] : (result.checkpoints ?? []);
  };

  const branchCheckpoint = async (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionBranchResult> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      throw new Error("Session checkpoint operation requires an active Gateway connection");
    }
    const result = await branchSessionCheckpoint(client, key, checkpointId, options);
    if (disposed || gateway.snapshot.client !== client) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway client");
    }
    await refresh({
      agentId: options.agentId ?? state.agentId ?? undefined,
      force: true,
    });
    return result;
  };

  const restoreCheckpoint = async (
    key: string,
    checkpointId: string,
    options: { agentId?: string | null } = {},
  ): Promise<SessionsCompactionRestoreResult> => {
    const client = gateway.snapshot.client;
    if (!client || !gateway.snapshot.connected || disposed) {
      throw new Error("Session checkpoint operation requires an active Gateway connection");
    }
    const result = await restoreSessionCheckpoint(client, key, checkpointId, options);
    if (disposed || gateway.snapshot.client !== client) {
      throw new Error("Session checkpoint operation completed on a replaced Gateway client");
    }
    await refresh({
      agentId: options.agentId ?? state.agentId ?? undefined,
      force: true,
    });
    return result;
  };

  const stopGateway = gateway.subscribe((next) => {
    if (!next.connected || !next.client) {
      subscribedClient = null;
      publish({ result: null, agentId: null, loading: false, error: null, deletedKeys: [] });
      return;
    }
    if (subscribedClient !== next.client) {
      const client = next.client;
      subscribedClient = client;
      void (async () => {
        try {
          await subscribeSessionGateway(client);
        } catch (error) {
          if (!disposed && gateway.snapshot.client === client) {
            publish({ ...state, error: String(error) });
          }
        } finally {
          if (!disposed && gateway.snapshot.client === client) {
            await refresh();
          }
        }
      })();
      return;
    }
    void refresh();
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (isSessionEvent(event)) {
      if (!canReconcileSessionEvent(lastListOptions)) {
        void refresh({ ...lastListOptions, force: true });
        return;
      }
      const reconciled = reconcileSessionChanged(state.result, event.payload, {
        resultAgentId: state.agentId,
        showArchived: lastListOptions.showArchived,
      });
      if (reconciled.applied) {
        if (reconciled.result !== state.result || reconciled.deletedKey) {
          publish({
            ...state,
            result: reconciled.result,
            error: null,
            deletedKeys: reconciled.deletedKey ? [reconciled.deletedKey] : [],
          });
        }
        return;
      }
      void refresh({ ...lastListOptions, force: true });
    }
  });

  return {
    get state() {
      return state;
    },
    list: requestList,
    reconcile,
    refresh,
    create,
    patch,
    delete: remove,
    deleteMany: removeMany,
    reset,
    compact,
    steer,
    listFiles,
    getFile,
    subscribeMessages,
    unsubscribeMessages,
    listCheckpoints,
    branchCheckpoint,
    restoreCheckpoint,
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
