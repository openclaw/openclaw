import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsListResult } from "../../api/types.ts";
import type { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
} from "./session-capability.ts";
import {
  normalizeAgentId,
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "./session-key.ts";
import {
  buildSessionListParams,
  DEFAULT_SESSION_LIST_QUERY,
  normalizeManagedSessionListQuery,
} from "./session-requests.ts";
import { readSessionChangedEvent } from "./session-row-reconcile.ts";

export function isForegroundReplacement(options: SessionRefreshOptions): boolean {
  return options.append !== true && options.backgroundHydrate !== true;
}

export function sessionListAgentMatcher(agentId?: string | null) {
  const normalized = agentId ? normalizeAgentId(agentId) : null;
  return (queryAgentId?: string) =>
    !normalized || !queryAgentId?.trim() || normalizeAgentId(queryAgentId) === normalized;
}

/** Capture membership before event reconciliation can remove or move a known child. */
export function sessionListEventMatcher(payload: unknown) {
  const info = readSessionChangedEvent(payload);
  const event = asOptionalRecord(payload);
  const source = asOptionalRecord(event?.session) ?? event;
  const agentId =
    info?.agentId ??
    parseAgentSessionKey(info?.key)?.agentId ??
    (typeof event?.agentId === "string" ? event.agentId : undefined);
  const matchesAgent = sessionListAgentMatcher(agentId);
  const owners = [
    source?.controlOwnerSessionKey,
    source?.spawnedBy,
    source?.parentSessionKey,
    event?.parentSessionKey,
  ].filter((owner): owner is string => typeof owner === "string" && owner.trim().length > 0);
  return (entry: ManagedSessionList): boolean => {
    const parent = entry.scope.spawnedBy;
    if (parent && info && areUiSessionKeysEquivalent(info.key, parent)) {
      return true;
    }
    if (!matchesAgent(sessionListQueryAgentId(entry.query))) {
      return false;
    }
    if (!parent || !info) {
      return true;
    }
    if (
      entry.snapshot.result?.sessions.some((row) =>
        areUiSessionKeysEquivalent(row.key, info.key),
      ) ||
      owners.some((owner) => areUiSessionKeysEquivalent(owner, parent))
    ) {
      return true;
    }
    // An incomplete window cannot rule out a former child beyond its loaded page,
    // even when a move event names its new parent explicitly.
    const result = entry.snapshot.result;
    return (
      !result ||
      result.hasMore === true ||
      (result.totalCount ?? result.sessions.length) > result.sessions.length
    );
  };
}

export type QueuedSessionRefresh = {
  options: SessionRefreshOptions;
  completions: Array<{
    options: SessionRefreshOptions;
    complete: (refresh: Promise<SessionsListResult | null> | null) => void;
  }>;
};

export type ManagedSessionListRefresh = {
  append: boolean;
  offset?: number;
  invalidated?: true;
};

export type ObservedSessionList = {
  scope: SessionListScope;
  connectionEpoch: number | null;
  snapshot: SessionListSnapshot;
  listeners: Set<(snapshot: SessionListSnapshot) => void>;
};

export type ManagedSessionList = ObservedSessionList & {
  key: string;
  query: ReturnType<typeof normalizeManagedSessionListQuery>;
  retainedLimit: number;
  coordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;
  pending: Promise<void> | null;
  queued: ManagedSessionListRefresh | null;
};

export function isPrimarySessionListQuery(options: SessionListScope): boolean {
  if (options.includeDerivedTitles === false || options.includeLastMessage === false) {
    return false;
  }
  const query = normalizeManagedSessionListQuery(options);
  return (
    query.archived === undefined &&
    !query.spawnedBy &&
    (query.boardFace ?? query.hasBoard) === undefined &&
    !query.activeMinutes &&
    !query.search &&
    !query.ownerId &&
    query.involvingMe !== true &&
    query.includeGlobal === true &&
    query.includeUnknown === true &&
    query.configuredAgentsOnly === true
  );
}

export function sessionListQueryAgentId(
  query: ReturnType<typeof normalizeManagedSessionListQuery>,
): string | undefined {
  return typeof query.agentId === "string" ? query.agentId : undefined;
}

export function isSameSessionListQuery(
  previous: SessionListScope,
  next: SessionListScope,
  append: boolean,
): boolean {
  const previousQuery = buildSessionListParams(previous);
  const nextQuery = buildSessionListParams(next);
  // Appending changes the page window without replacing its query owner.
  if (append) {
    previousQuery.limit = nextQuery.limit;
    previousQuery.ownerFirst = nextQuery.ownerFirst;
  }
  return JSON.stringify(previousQuery) === JSON.stringify(nextQuery);
}

export function prepareSessionRefreshOptions(
  options: SessionRefreshOptions,
  snapshot: SessionGateway["snapshot"],
): SessionRefreshOptions {
  // Every canonical roster replaces visible names, so omitted title enrichment
  // must inherit the UI default in both the request and its query identity.
  const prepared = { ...options, includeDerivedTitles: options.includeDerivedTitles ?? true };
  if (
    !snapshot.selfUser?.id.trim() ||
    prepared.append === true ||
    !isPrimarySessionListQuery(prepared)
  ) {
    return prepared;
  }
  return { ...prepared, ownerFirst: true };
}

export function completeSessionRefreshWaiters(
  queued: QueuedSessionRefresh,
  nextOptions: SessionRefreshOptions,
  next: Promise<SessionsListResult | null> | null,
  snapshot: SessionGateway["snapshot"],
): void {
  // Coalescing shares completion timing, but only equivalent queries share the result.
  queued.completions.forEach(({ options, complete }) => {
    const sameQuery = isSameSessionListQuery(
      prepareSessionRefreshOptions(options, snapshot),
      nextOptions,
      false,
    );
    complete(sameQuery ? next : (next?.then(() => null) ?? null));
  });
}

export function retainSessionPaginationWindow(
  options: SessionListOptions,
  offset: number | undefined,
  result: SessionsListResult | null,
  nextResult: SessionsListResult,
  snapshot: SessionGateway["snapshot"],
): SessionListOptions {
  const ownerFirstPage =
    Boolean(snapshot.selfUser?.id.trim()) && isPrimarySessionListQuery(options);
  const retainedListLimit =
    ownerFirstPage && result && typeof offset === "number"
      ? offset + result.sessions.length
      : nextResult.sessions.length;
  // Retain the shared pagination window, excluding owner rows merged ahead of it.
  return {
    ...options,
    limit: Math.max(options.limit ?? DEFAULT_SESSION_LIST_QUERY.limit, retainedListLimit),
  };
}
