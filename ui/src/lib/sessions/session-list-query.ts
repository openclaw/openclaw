import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsListResult } from "../../api/types.ts";
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
  matchesExistingSession,
  parseSessionChangedEvent,
  reconcileSessionChangedRow,
  sessionChangedSnapshots,
} from "./session-row-reconcile.ts";

const ROW_SNAPSHOT_REASONS = new Set([
  "patch",
  "send",
  "steer",
  "agent.run.started",
  "agent.input.settled",
  "run-capacity",
  "chat.title",
]);

/** Only a held member moving within a known roster can replace a list read. */
export function canApplySessionListSnapshot(
  result: SessionsListResult | null,
  payload: unknown,
  options: SessionListOptions,
): boolean {
  const parsed = parseSessionChangedEvent(payload);
  if (!result || !parsed || !isPrimarySessionListQuery({ ...options, archivedFilter: "active" })) {
    return false;
  }
  const [eventInfo, event] = parsed;
  if (
    !asOptionalRecord(event.session) ||
    event.catalogChanged === true ||
    event.phase === "reset" ||
    (eventInfo.reason !== null && !ROW_SNAPSHOT_REASONS.has(eventInfo.reason)) ||
    (options.offset ?? 0) > 0
  ) {
    return false;
  }
  const snapshots = sessionChangedSnapshots(payload);
  const complete = Array.isArray(event.ancestorSessions);
  let held = false;
  for (const snapshot of snapshots) {
    const parsedSnapshot = parseSessionChangedEvent(snapshot);
    if (!parsedSnapshot) {
      return false;
    }
    const [info] = parsedSnapshot;
    const agentId = info.agentId ?? parseAgentSessionKey(info.key)?.agentId;
    if (
      options.agentId &&
      agentId &&
      normalizeAgentId(options.agentId) !== normalizeAgentId(agentId)
    ) {
      continue;
    }
    const existing = result.sessions.find((row) =>
      matchesExistingSession(row, info.key, info.agentId ?? options.agentId ?? null),
    );
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
      (existing.archived === true) !== (next.archived === true) ||
      (existing.pinned === true) !== (next.pinned === true) ||
      existing.pinnedAt !== next.pinnedAt ||
      JSON.stringify(existing.owner) !== JSON.stringify(next.owner) ||
      JSON.stringify(existing.createdActor) !== JSON.stringify(next.createdActor) ||
      existing.spawnedBy !== next.spawnedBy ||
      existing.controlOwnerSessionKey !== next.controlOwnerSessionKey ||
      existing.parentSessionKey !== next.parentSessionKey
    ) {
      return false;
    }
    const parentKeys = [
      existing.spawnedBy,
      existing.controlOwnerSessionKey,
      existing.parentSessionKey,
    ];
    // Missing certification means the bounded Gateway traversal was incomplete.
    if (
      (!complete &&
        (isSubagentSessionKey(existing.key) ||
          parentKeys.some(Boolean) ||
          existing.childSessions?.length)) ||
      result.sessions.some(
        (parent) =>
          (parentKeys.some((key) => key && areUiSessionKeysEquivalent(key, parent.key)) ||
            parent.childSessions?.some((key) => areUiSessionKeysEquivalent(key, existing.key))) &&
          (!complete ||
            !snapshots.some((candidate) => {
              const candidateInfo = parseSessionChangedEvent(candidate)?.[0];
              return (
                candidateInfo &&
                matchesExistingSession(parent, candidateInfo.key, candidateInfo.agentId)
              );
            })),
      )
    ) {
      return false;
    }
    // A member whose rank only improves cannot evict another member. Missing rows,
    // pin/archive/owner changes and backwards clocks need authoritative admission.
    if (info.updatedAt === null || info.updatedAt < (existing.updatedAt ?? 0)) {
      return false;
    }
    // Owner-first and retained selection can add rows outside the shared page.
    // Promoting one can displace its boundary despite already being displayed.
    if (
      info.updatedAt !== existing.updatedAt &&
      result.sessions.length >
        (result.nextOffset ??
          result.limitApplied ??
          options.limit ??
          DEFAULT_SESSION_LIST_QUERY.limit)
    ) {
      return false;
    }
    held = true;
  }
  return held;
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
export function sessionListEventMatcher(payload: unknown, fallbackAgentId?: string | null) {
  const matches = sessionChangedSnapshots(payload).map((snapshot) =>
    sessionListSnapshotMatcher(snapshot, fallbackAgentId),
  );
  return (scope: SessionListScope, result?: SessionsListResult | null): boolean =>
    matches.some((match) => match(scope, result));
}

function sessionListSnapshotMatcher(payload: unknown, fallbackAgentId?: string | null) {
  const parsed = parseSessionChangedEvent(payload);
  const info = parsed?.[0];
  const event = parsed?.[1] ?? asOptionalRecord(payload);
  const source = parsed?.[2];
  const matchesAgent = sessionListAgentMatcher(
    info?.agentId ??
      parseAgentSessionKey(info?.key)?.agentId ??
      (typeof event?.agentId === "string" ? event.agentId : fallbackAgentId),
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
    query.excludeSubagents !== true &&
    query.excludeCron !== true &&
    query.excludeSystem !== true &&
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
