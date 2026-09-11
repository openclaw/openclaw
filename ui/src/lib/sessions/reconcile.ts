import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { compareSessionRowsByUpdatedAt, sessionMatchesArchivedFilter } from "./navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
  type UiSessionDefaultsHost,
} from "./session-key.ts";
import {
  isPersistedSessionRow,
  isSessionRowOutsideResultScope,
  matchesExistingSession,
  preserveRosterPresentationMetadata,
  readSessionChangedEvent,
  reconcileSessionChangedRow,
  reconcileSessionRow,
  type SessionChangedRowProjection,
  type SessionChangedRowResult,
  type SessionReconcileOptions,
  type SessionRowObservation,
} from "./session-row-reconcile.ts";
import { preserveOmittedThinkingMetadata } from "./session-thinking-metadata.ts";

export {
  preserveRosterPresentationMetadata,
  readSessionChangedEvent,
  reconcileSessionChangedRow,
  reconcileSessionRow,
} from "./session-row-reconcile.ts";
export type { SessionReconcileOptions, SessionRowObservation } from "./session-row-reconcile.ts";

export type SessionChangedResult = Omit<
  SessionChangedRowResult,
  "reconciled" | "eventTs" | "ownershipChanged" | "disposition"
> & { result: SessionsListResult | null };

/** Merge canonical and filtered pages with the same cursor/deduplication contract. */
export function appendSessionResults(
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

export function reconcileRosterPresentationMetadata(
  incoming: SessionsListResult | null,
  existing: SessionsListResult | null,
): SessionsListResult | null {
  if (!incoming || !existing) {
    return incoming;
  }
  const existingByKey = new Map(existing.sessions.map((session) => [session.key, session]));
  let changed = false;
  const sessions = incoming.sessions.map((session) => {
    const reconciled = preserveRosterPresentationMetadata(session, existingByKey.get(session.key));
    changed ||= reconciled !== session;
    return reconciled;
  });
  return changed ? { ...incoming, sessions } : incoming;
}

export function preserveCurrentSessionRow(
  result: SessionsListResult,
  state: { result: Pick<SessionsListResult, "sessions"> | null; agentId: string | null },
  snapshot: UiSessionDefaultsHost & { sessionKey?: string },
  backgroundHydrate: boolean,
): SessionsListResult {
  const currentKey = snapshot.sessionKey?.trim();
  if (!currentKey) {
    return result;
  }
  const parsedAgentId = parseAgentSessionKey(currentKey)?.agentId;
  const currentAgentId = normalizeAgentId(
    parsedAgentId ?? resolveUiSelectedGlobalAgentId(snapshot),
  );
  if (!parsedAgentId && normalizeAgentId(state.agentId ?? "") !== currentAgentId) {
    return result;
  }
  const matchesCurrent = (row: GatewaySessionRow) =>
    uiSessionRowMatchesSelectedChat(snapshot, row.key, currentKey, row.agentId);
  const previousCurrentRow = state.result?.sessions.find(matchesCurrent);
  if (
    previousCurrentRow &&
    (backgroundHydrate || previousCurrentRow.archived === true) &&
    !result.sessions.some(matchesCurrent)
  ) {
    const sessions = [...result.sessions, previousCurrentRow];
    return { ...result, count: sessions.length, sessions };
  }
  return result;
}

export function reconcileSessionChanged(
  result: SessionsListResult | null,
  payload: unknown,
  options: SessionReconcileOptions = {},
  project?: SessionChangedRowProjection,
): SessionChangedResult {
  const info = readSessionChangedEvent(payload);
  const selectedGlobalAgentId = info?.agentId ?? options.selectedGlobalAgentId ?? null;
  const existing = info
    ? result?.sessions.find((candidate) =>
        matchesExistingSession(candidate, info.key, selectedGlobalAgentId),
      )
    : undefined;
  const { row, admittedRow, reconciled, eventTs, ownershipChanged, disposition, ...eventResult } =
    reconcileSessionChangedRow(existing, payload, options, project);
  if (disposition === "outside-scope") {
    // A foreign row cannot advance this query's clock or invalidate its owner facet.
    return { ...eventResult, row: existing, result };
  }
  if (eventResult.deletedKey) {
    if (!result || !existing) {
      return { ...eventResult, result };
    }
    const sessions = result.sessions.filter((candidate) => candidate !== existing);
    return { ...eventResult, result: { ...result, count: sessions.length, sessions } };
  }
  if (!reconciled) {
    // With no roster, ordinary event fields never establish list admission.
    return !result && eventResult.applied ? { applied: false, result } : { ...eventResult, result };
  }
  if (!result || !existing) {
    return { applied: false, result };
  }
  let next = result;
  if (row !== existing) {
    const sessions = row
      ? [...result.sessions.filter((candidate) => candidate.key !== existing.key), row].toSorted(
          compareSessionRowsByUpdatedAt,
        )
      : result.sessions.filter((candidate) => candidate.key !== existing.key);
    next = { ...result, count: sessions.length, sessions };
  }
  const timestamped = eventTs !== undefined && eventTs > next.ts ? { ...next, ts: eventTs } : next;
  // Facets describe the whole query, so the list adapter owns their invalidation.
  const published = ownershipChanged ? { ...timestamped, owners: undefined } : timestamped;
  const retainedRow = info
    ? published.sessions.find((candidate) =>
        matchesExistingSession(candidate, info.key, selectedGlobalAgentId),
      )
    : undefined;
  return { ...eventResult, row: retainedRow, admittedRow, result: published };
}

export function reconcileSessionHistory(
  result: SessionsListResult | null,
  row: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  options: SessionReconcileOptions = {},
  preserveMatchingExistingRow = false,
  observation?: SessionRowObservation,
): SessionsListResult | null {
  if (!row?.key || isSessionRowOutsideResultScope(row, options)) {
    return result;
  }
  if (!result) {
    if (!isPersistedSessionRow(row) && !defaults) {
      return null;
    }
    // An excluded first row never enters a list or its observation callbacks.
    const reduced =
      isPersistedSessionRow(row) &&
      sessionMatchesArchivedFilter(row, options.archivedFilter ?? "active")
        ? reconcileSessionRow(row, undefined, { ...options, archivedFilter: "all" }, observation)
        : undefined;
    const sessions = reduced?.row ? [reduced.row] : [];
    return {
      ts: Date.now(),
      path: "",
      count: sessions.length,
      defaults: defaults ?? { modelProvider: null, model: null, contextTokens: null },
      sessions,
    };
  }
  const matching = result.sessions.find((candidate) =>
    matchesExistingSession(
      candidate,
      row.key,
      row.agentId ?? options.selectedGlobalAgentId ?? null,
    ),
  );
  const nextDefaults = defaults
    ? preserveOmittedThinkingMetadata(defaults, result.defaults)
    : result.defaults;
  const resultWithDefaults =
    nextDefaults === result.defaults ? result : { ...result, defaults: nextDefaults };
  const reduced = reconcileSessionRow(
    row,
    matching,
    { ...options, preserveExisting: preserveMatchingExistingRow },
    observation,
  );
  if (
    reduced.disposition === "older" ||
    reduced.disposition === "outside-scope" ||
    reduced.disposition === "invalid"
  ) {
    return result;
  }
  if (reduced.disposition !== "accepted") {
    return resultWithDefaults;
  }
  const visibleKey = matching?.key ?? row.key;
  const sessions = reduced.row
    ? [
        ...result.sessions.filter((candidate) => candidate.key !== visibleKey),
        reduced.row,
      ].toSorted(compareSessionRowsByUpdatedAt)
    : result.sessions.filter((candidate) => candidate.key !== visibleKey);
  return { ...result, defaults: nextDefaults, count: sessions.length, sessions };
}
