import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { sessionMatchesArchivedFilter } from "./navigation.ts";
import type {
  SessionGateway,
  SessionListOptions,
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
  SessionRefreshOutcome,
} from "./session-capability.ts";
import {
  normalizeAgentId,
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "./session-key.ts";
import {
  buildSessionListParams,
  DEFAULT_SESSION_LIST_QUERY,
  normalizeManagedSessionListQuery,
} from "./session-requests.ts";
import {
  hasSessionChangedAncestorCoverage,
  matchesExistingSession,
  parseSessionChangedEvent,
  reconcileSessionChangedRow,
  sessionChangedSnapshots,
} from "./session-row-reconcile.ts";

type SessionListRowLookup = (key: string, agentId?: string | null) => GatewaySessionRow | undefined;

/** Held members and certified query exclusions can replace a list read. */
export function canApplySessionListSnapshot(
  result: SessionsListResult | null,
  payload: unknown,
  options: SessionListOptions,
  sortBy: "updatedAt" | "activity" = "updatedAt",
  observedRow?: SessionListRowLookup,
): boolean {
  const parsed = parseSessionChangedEvent(payload);
  const countsOnly = options.includeOwnerSessionCounts === true;
  if (
    !result ||
    !parsed ||
    !isPrimarySessionListQuery({
      ...options,
      archivedFilter: "active",
      excludeSubagents: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      includeGlobal: true,
      includeUnknown: true,
      hasBoard: undefined,
      boardFace: undefined,
      spawnedBy: undefined,
      includeOwnerSessionCounts: false,
      excludeCron: countsOnly ? false : options.excludeCron,
      excludeSystem: countsOnly ? false : options.excludeSystem,
    })
  ) {
    return false;
  }
  const [, event] = parsed;
  if (
    !asOptionalRecord(event.session) ||
    event.catalogChanged === true ||
    event.phase === "reset" ||
    (options.offset ?? 0) > 0
  ) {
    return false;
  }
  const snapshots = sessionChangedSnapshots(payload);
  const complete = Array.isArray(event.ancestorSessions);
  let covered = false;
  for (const snapshot of snapshots) {
    const parsedSnapshot = parseSessionChangedEvent(snapshot);
    if (!parsedSnapshot) {
      return false;
    }
    const [info, , source] = parsedSnapshot;
    const agentId = info.agentId ?? parseAgentSessionKey(info.key)?.agentId;
    if (
      options.agentId &&
      agentId &&
      normalizeAgentId(options.agentId) !== normalizeAgentId(agentId)
    ) {
      continue;
    }
    // The owner-count adapter consumes the aggregate, not the single sampled row.
    const existing =
      result.sessions.find((row) =>
        matchesExistingSession(row, info.key, info.agentId ?? options.agentId ?? null),
      ) ?? (countsOnly ? observedRow?.(info.key, info.agentId) : undefined);
    const parent = options.spawnedBy;
    if (parent && areUiSessionKeysEquivalent(info.key, parent)) {
      // A parent cannot belong to its own child query. Its own event must still
      // certify unchanged children; ancestor copies accompany the child's facts.
      if (snapshot === payload) {
        const children = source.childSessions;
        if (
          !complete ||
          result.hasMore !== false ||
          !Array.isArray(source.childOwnerSessionKeys) ||
          (children !== undefined && !Array.isArray(children)) ||
          (source.isMain === true && children === undefined) ||
          (children ?? []).length !== result.sessions.length ||
          !result.sessions.every((row) =>
            (children ?? []).some(
              (key) => typeof key === "string" && areUiSessionKeysEquivalent(row.key, key),
            ),
          )
        ) {
          return false;
        }
      }
      covered = true;
      continue;
    }
    const subagentExcluded = options.excludeSubagents === true && isSubagentSessionKey(info.key);
    const parentKeys = [
      existing?.spawnedBy ?? source.spawnedBy,
      existing?.controlOwnerSessionKey ?? source.controlOwnerSessionKey,
      existing?.parentSessionKey ?? source.parentSessionKey,
    ].filter((key): key is string => typeof key === "string" && Boolean(key));
    // Missing certification means the bounded Gateway traversal was incomplete.
    if (
      (!complete &&
        (isSubagentSessionKey(info.key) ||
          parentKeys.length > 0 ||
          existing?.childSessions?.length)) ||
      !hasSessionChangedAncestorCoverage(
        result.sessions,
        info.key,
        parentKeys,
        complete ? snapshots : undefined,
      )
    ) {
      return false;
    }
    if (subagentExcluded) {
      covered = true;
      continue;
    }
    const excluded =
      !existing &&
      complete &&
      (info.isAncestorReference
        ? reconcileSessionChangedRow(observedRow?.(info.key, info.agentId), snapshot, {
            resultAgentId: options.agentId,
            archivedFilter: "all",
          }).admittedRow
        : source);
    if (
      excluded &&
      ((parent &&
        Array.isArray(excluded.childOwnerSessionKeys) &&
        !excluded.childOwnerSessionKeys.includes(parent)) ||
        (options.hasBoard !== undefined &&
          typeof excluded.hasBoard === "boolean" &&
          excluded.hasBoard !== options.hasBoard) ||
        (options.boardFace !== undefined && excluded.boardFace !== options.boardFace) ||
        (options.includeGlobal === false && excluded.kind === "global") ||
        (options.excludeDock !== false && excluded.isDock === true) ||
        (options.includeUnknown === false && excluded.kind === "unknown"))
    ) {
      covered = true;
      continue;
    }
    const next = reconcileSessionChangedRow(existing, snapshot, {
      resultAgentId: options.agentId,
      archivedFilter: "all",
    }).admittedRow;
    if (
      !existing ||
      !next ||
      !sessionMatchesArchivedFilter(existing, options.archivedFilter ?? "active") ||
      existing.sessionId !== next.sessionId ||
      existing.kind !== next.kind ||
      (options.excludeDock !== false && (existing.isDock === true || next.isDock === true)) ||
      (existing.archived === true) !== (next.archived === true) ||
      (existing.pinned === true) !== (next.pinned === true) ||
      existing.pinnedAt !== next.pinnedAt ||
      JSON.stringify(existing.owner) !== JSON.stringify(next.owner) ||
      JSON.stringify(existing.createdActor) !== JSON.stringify(next.createdActor) ||
      existing.spawnedBy !== next.spawnedBy ||
      existing.controlOwnerSessionKey !== next.controlOwnerSessionKey ||
      existing.parentSessionKey !== next.parentSessionKey ||
      (countsOnly &&
        (existing.hasActiveRun !== next.hasActiveRun ||
          existing.status !== next.status ||
          existing.visibility !== next.visibility ||
          existing.sharingRole !== next.sharingRole ||
          existing.category !== next.category ||
          existing.classification !== next.classification ||
          // Stored labels prove stable system filtering; presented fallback names cannot.
          (!(existing.label?.trim() && next.label?.trim()) &&
            !(
              (existing.createdActor?.type === "human" ||
                existing.createdActor?.type === "system") &&
              existing.classification !== "heartbeat"
            )))) ||
      (parent &&
        (!existing.childOwnerSessionKeys?.includes(parent) ||
          !next.childOwnerSessionKeys?.includes(parent))) ||
      (options.hasBoard !== undefined &&
        (existing.hasBoard !== options.hasBoard || next.hasBoard !== options.hasBoard)) ||
      (options.boardFace !== undefined &&
        (existing.boardFace !== options.boardFace || next.boardFace !== options.boardFace))
    ) {
      return false;
    }
    // A member whose rank only improves cannot evict another member. Missing rows,
    // pin/archive/owner changes and backwards clocks need authoritative admission.
    if (
      !info.isAncestorReference &&
      (info.updatedAt === null ||
        info.updatedAt < (existing.updatedAt ?? 0) ||
        (info.snapshotAt !== undefined && info.snapshotAt < (existing.snapshotAt ?? 0)) ||
        (sortBy === "activity" &&
          sessionActivityTimestamp(next) < sessionActivityTimestamp(existing)))
    ) {
      return false;
    }
    // Owner-first and retained selection can add rows outside the shared page.
    // Promoting one can displace its boundary despite already being displayed.
    if (
      !info.isAncestorReference &&
      info.updatedAt !== existing.updatedAt &&
      result.hasMore !== false &&
      result.sessions.length >
        (result.nextOffset ??
          result.limitApplied ??
          options.limit ??
          DEFAULT_SESSION_LIST_QUERY.limit)
    ) {
      return false;
    }
    covered = true;
  }
  return covered;
}

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
  const matches = sessionChangedSnapshots(payload).map(sessionListSnapshotMatcher);
  return (scope: SessionListScope, result?: SessionsListResult | null): boolean =>
    matches.some((match) => match(scope, result));
}

function sessionListSnapshotMatcher(payload: unknown) {
  const parsed = parseSessionChangedEvent(payload);
  const info = parsed?.[0];
  const event = parsed?.[1] ?? asOptionalRecord(payload);
  const source = parsed?.[2];
  const matchesAgent = sessionListAgentMatcher(
    info?.agentId ??
      parseAgentSessionKey(info?.key)?.agentId ??
      (typeof event?.agentId === "string" ? event.agentId : undefined),
  );
  const owners = [
    source?.controlOwnerSessionKey,
    source?.spawnedBy,
    source?.parentSessionKey,
    event?.parentSessionKey,
  ];
  return (scope: SessionListScope, result?: SessionsListResult | null): boolean => {
    const parent = scope.spawnedBy;
    if (parent && info && areUiSessionKeysEquivalent(info.key, parent)) {
      return true;
    }
    if (!matchesAgent(scope.agentId)) {
      return false;
    }
    if (!parent || !info) {
      return true;
    }
    if (
      result?.sessions.some((row) => areUiSessionKeysEquivalent(row.key, info.key)) ||
      owners.some((owner) => typeof owner === "string" && areUiSessionKeysEquivalent(owner, parent))
    ) {
      return true;
    }
    // An incomplete window cannot rule out a former child beyond its loaded page,
    // even when a move event names its new parent explicitly.
    return (
      !result ||
      result.hasMore === true ||
      (result.totalCount ?? result.sessions.length) > result.sessions.length
    );
  };
}

export type SessionRefreshAttempt = {
  options: SessionRefreshOptions;
  matchesRequestedQuery: boolean;
  result: SessionsListResult | null;
  outcome: SessionRefreshOutcome;
};

/** Return only outcomes whose accepted request reconciled this mutation's scope. */
export function sessionMutationRefreshOutcome(
  attempt: SessionRefreshAttempt | null,
  agentId: string | null | undefined,
): SessionRefreshOutcome | null {
  if (!attempt) {
    return null;
  }
  if (attempt.outcome.status === "failed" || !agentId?.trim()) {
    return attempt.matchesRequestedQuery ? attempt.outcome : null;
  }
  const result = attempt.result;
  const complete =
    result &&
    !result.hasMore &&
    (result.totalCount ?? result.sessions.length) <= result.sessions.length;
  return !attempt.options.append &&
    sessionListAgentMatcher(agentId)(attempt.options.agentId) &&
    (attempt.options.agentId?.trim() || complete)
    ? attempt.outcome
    : null;
}

export type QueuedSessionRefresh = {
  options: SessionRefreshOptions;
  intent: "explicit" | "automatic" | "reconcile" | (() => string | null);
  foreground?: boolean;
  bootstrap?: boolean;
  errorOwner: { options: SessionRefreshOptions; isCurrent?: () => boolean };
  completions: Array<{
    options: SessionRefreshOptions;
    reconcile: boolean;
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
    current.foreground = next.foreground;
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
  /** A live primary window may be reused for selection until its next invalidation. */
  warmPrimary?: boolean;
  key: string;
  query: ReturnType<typeof normalizeManagedSessionListQuery>;
  retainedLimit: number;
  startupRetryAttempt: number;
  /** Invalidation retires remaining pages without cancelling the correlated RPC. */
  readGeneration: number;
  coordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;
  pending: Promise<void> | null;
  queued: ManagedSessionListRefresh | null;
};

export function sessionListsNeedingEventRefresh(
  lists: Iterable<ManagedSessionList>,
  payload: unknown,
  matches: ReturnType<typeof sessionListEventMatcher>,
  observedRow: SessionListRowLookup,
): Set<ManagedSessionList> {
  const invalidated = new Set<ManagedSessionList>();
  for (const entry of lists) {
    if (
      matches(entry.query, entry.snapshot.result) &&
      (entry.pending !== null ||
        entry.snapshot.error !== null ||
        !canApplySessionListSnapshot(
          entry.snapshot.result,
          payload,
          entry.scope,
          "updatedAt",
          observedRow,
        ))
    ) {
      invalidated.add(entry);
    }
  }
  return invalidated;
}

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
    query.includeOwnerSessionCounts !== true &&
    query.excludeSubagents !== true &&
    query.excludeCron !== true &&
    query.excludeSystem !== true &&
    query.excludeDock !== false &&
    query.includeGlobal === true &&
    query.includeUnknown === true &&
    query.configuredAgentsOnly === true
  );
}

export function isSameSessionListQuery(
  previous: SessionListScope,
  next: SessionListScope,
  append: boolean,
): boolean {
  const { source: _previousSource, ...previousQuery } = buildSessionListParams(previous);
  const { source: _nextSource, ...nextQuery } = buildSessionListParams(next);
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
  const prepared = {
    ...options,
    source: options.source ?? "sidebar",
    excludeDock: options.excludeDock ?? true,
    includeDerivedTitles: options.includeDerivedTitles ?? true,
  } satisfies SessionRefreshOptions;
  if (
    !snapshot.selfUser?.id.trim() ||
    prepared.append === true ||
    !isPrimarySessionListQuery(prepared)
  ) {
    return prepared;
  }
  return { ...prepared, ownerFirst: true };
}

export function queuedSessionRefreshCompletion(
  queued: QueuedSessionRefresh | null,
  options: SessionRefreshOptions,
): Promise<SessionRefreshAttempt | null> | null {
  return queued
    ? new Promise((resolve) => {
        queued.completions.push({ options, reconcile: false, complete: resolve });
      })
    : null;
}

export function completeSessionRefreshWaiters(
  queued: QueuedSessionRefresh,
  next: Promise<SessionRefreshAttempt | null>,
  reconciled: Promise<SessionRefreshAttempt | null>,
  snapshot: SessionGateway["snapshot"],
): void {
  queued.completions.forEach(({ options, reconcile, complete }) => {
    const requested = prepareSessionRefreshOptions(options, snapshot);
    // Public results match their own query; reconciliation also needs the accepted scope.
    complete(
      (reconcile ? reconciled : next).then((attempt) =>
        attempt
          ? {
              ...attempt,
              matchesRequestedQuery: isSameSessionListQuery(requested, attempt.options, false),
            }
          : null,
      ),
    );
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
