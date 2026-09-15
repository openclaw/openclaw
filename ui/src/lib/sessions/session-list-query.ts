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
import { parseSessionChangedEvent } from "./session-row-reconcile.ts";

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
  const parsed = parseSessionChangedEvent(payload);
  const info = parsed?.[0];
  const event = parsed?.[1] ?? asOptionalRecord(payload);
  const source = parsed?.[2];
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
  ];
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
      owners.some((owner) => typeof owner === "string" && areUiSessionKeysEquivalent(owner, parent))
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

export type SessionRefreshOutcome =
  | { status: "refreshed" | "stale" }
  | { status: "failed"; error: string };

export type SessionRefreshAttempt = {
  result: SessionsListResult | null;
  outcome: SessionRefreshOutcome;
};

export type QueuedSessionRefresh = {
  options: SessionRefreshOptions;
  intent: "explicit" | "automatic" | "reconcile" | (() => string | null);
  bootstrap?: boolean;
  errorOwner: { options: SessionRefreshOptions; isCurrent?: () => boolean };
  completions: Array<{
    options: SessionRefreshOptions;
    complete: (refresh: Promise<SessionRefreshAttempt | null> | null) => void;
  }>;
};

export function coalesceSessionRefresh(
  current: QueuedSessionRefresh | null,
  next: QueuedSessionRefresh,
  snapshot: SessionGateway["snapshot"],
): QueuedSessionRefresh {
  if (!current) {
    return next;
  }
  // Explicit intent remains authoritative over automatic hydration and weaker queries.
  if (
    (next.intent !== "automatic" || current.intent === "automatic") &&
    (next.intent !== "reconcile" ||
      current.intent === "automatic" ||
      current.intent === "reconcile") &&
    (isForegroundReplacement(next.options) || !isForegroundReplacement(current.options))
  ) {
    current.options = next.options;
    current.intent = next.intent;
    current.bootstrap = next.bootstrap;
    current.errorOwner = next.errorOwner;
  } else if (
    next.intent === "reconcile" &&
    isSameSessionListQuery(
      prepareSessionRefreshOptions(current.options, snapshot),
      prepareSessionRefreshOptions(next.options, snapshot),
      false,
    )
  ) {
    // Reconciliation may own a matching query's error without replacing selection.
    current.errorOwner = next.errorOwner;
  }
  current.completions.push(...next.completions);
  return current;
}

export type ManagedSessionListRefresh = {
  append: boolean;
  offset?: number;
  invalidated?: true;
  background?: true;
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
  next: Promise<SessionRefreshAttempt | null> | null,
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
