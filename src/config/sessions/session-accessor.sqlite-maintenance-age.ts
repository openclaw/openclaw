import type { DatabaseSync } from "node:sqlite";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionMaintenanceAgeQueries } from "./session-accessor.sqlite-maintenance-age-queries.js";
import { hasCanonicalSessionValidationProjection } from "./session-canonical-key.js";
import { getSessionMaintenanceActivityAt } from "./store-maintenance-activity.js";
import {
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryMaintenanceAgeFact = {
  maintenance: ResolvedSessionMaintenanceConfig;
  entryCount?: number;
  next: { at: number };
  recheckAt: number;
};
type SessionEntryMaintenanceAgeCapture = { fact?: SessionEntryMaintenanceAgeFact };
type MaintenanceActivity = Pick<
  SessionEntry,
  "updatedAt" | "lastActivityAt" | "lastInteractionAt" | "sessionStartedAt" | "archivedAt"
>;
export type SessionEntryMaintenanceAgeChange = {
  sessionKey: string;
  entry: MaintenanceActivity;
  previousEntry?: MaintenanceActivity;
};
const changeObservers = new Map<
  string | symbol,
  Set<(change: SessionEntryMaintenanceAgeChange) => void>
>();

export function captureSessionEntryMaintenanceAgeChange(
  change: SessionEntryMaintenanceAgeChange,
): SessionEntryMaintenanceAgeChange {
  const pick = ({
    updatedAt,
    lastActivityAt,
    lastInteractionAt,
    sessionStartedAt,
    archivedAt,
  }: MaintenanceActivity) => ({
    updatedAt,
    lastActivityAt,
    lastInteractionAt,
    sessionStartedAt,
    archivedAt,
  });
  return {
    sessionKey: change.sessionKey,
    entry: pick(change.entry),
    previousEntry: change.previousEntry && pick(change.previousEntry),
  };
}

export function observeSessionEntryMaintenanceAgeChanges(
  identity: string | symbol,
  observe: (change: SessionEntryMaintenanceAgeChange) => void,
): () => void {
  const observers = changeObservers.get(identity) ?? new Set();
  observers.add(observe);
  changeObservers.set(identity, observers);
  return () => {
    observers.delete(observe);
    if (!observers.size && changeObservers.get(identity) === observers) {
      changeObservers.delete(identity);
    }
  };
}

export function publishSessionEntryMaintenanceAgeChanges(
  identity: string | symbol,
  changes: readonly SessionEntryMaintenanceAgeChange[],
): void {
  for (const change of changes) {
    for (const observe of changeObservers.get(identity) ?? []) {
      observe(change);
    }
  }
}

type Activity = Parameters<typeof getSessionMaintenanceActivityAt>[0];

export const SESSION_ENTRY_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1_000;

// Ordinary updates retain this age lower bound across entry-cache revision churn.
const ageFacts = new WeakMap<DatabaseSync, SessionEntryMaintenanceAgeCapture>();

export function stageSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  fact: SessionEntryMaintenanceAgeFact | undefined,
): void {
  if (
    stageSqliteTransactionState(db, {
      stage: () => ageFacts.set(db, { fact }),
      rollback: () => ageFacts.delete(db),
      commit: () => {},
    })
  ) {
    return;
  }
  if (!db.isTransaction) {
    ageFacts.set(db, { fact });
  }
}

export function invalidateSessionEntryMaintenanceAgeFact(db: DatabaseSync): void {
  ageFacts.delete(db);
}

export function readSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  maintenance: ResolvedSessionMaintenanceConfig,
): SessionEntryMaintenanceAgeFact | undefined {
  const fact = ageFacts.get(db)?.fact;
  if (!fact) {
    return undefined;
  }
  const now = Date.now();
  if (
    agePolicy(fact.maintenance) !== agePolicy(maintenance) ||
    now >= fact.recheckAt ||
    fact.recheckAt > now + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS
  ) {
    invalidateSessionEntryMaintenanceAgeFact(db);
    return undefined;
  }
  return fact;
}

function isDashboardKey(key: string): boolean {
  return parseAgentSessionKey(key)?.rest.startsWith("dashboard:") === true;
}

/** Tracked writes can only bring the conservative age boundary forward. */
export function advanceSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  update: SessionEntryMaintenanceAgeChange,
): void {
  if (changeObservers.size) {
    const identity = findOpenClawAgentDatabaseIdentity({ db })?.identity;
    if (identity !== undefined && changeObservers.has(identity)) {
      const change = captureSessionEntryMaintenanceAgeChange(update);
      const publish = () => publishSessionEntryMaintenanceAgeChanges(identity, [change]);
      if (!deferSqlitePostCommitPublication(db, publish) && !db.isTransaction) {
        publish();
      }
    }
  }
  applySessionEntryMaintenanceAgeChange(db, update);
}

export function applySessionEntryMaintenanceAgeChange(
  db: DatabaseSync,
  update: SessionEntryMaintenanceAgeChange,
): void {
  const fact = updateSessionEntryMaintenanceAgeFact(ageFacts.get(db)?.fact, update);
  // Reader handles can receive a coalesced change already applied by their writer.
  // Only the scheduling replica counts deltas; a database pass takes a fresh count.
  stageSessionEntryMaintenanceAgeFact(db, fact && { ...fact, entryCount: undefined });
}

/** The scheduling replica consumes the same acknowledged entry changes as the worker. */
export function updateSessionEntryMaintenanceAgeFact(
  fact: SessionEntryMaintenanceAgeFact | undefined,
  update: SessionEntryMaintenanceAgeChange,
): SessionEntryMaintenanceAgeFact | undefined {
  if (!fact) {
    return undefined;
  }
  if (update.entry.archivedAt !== undefined) {
    return {
      ...fact,
      entryCount:
        fact.entryCount === undefined || !update.previousEntry
          ? undefined
          : fact.entryCount - (update.previousEntry.archivedAt === undefined ? 1 : 0),
    };
  }
  const { entry, previousEntry } = update;
  if (previousEntry && !isMonotoneSessionEntryMaintenanceAgeChange(update)) {
    // Exact replacement/lifecycle writers also own backdates and archive restores.
    return undefined;
  }
  // A newly inserted historical entry must retain already-due transitions too.
  const at = nextEntryAgeAt(
    update.sessionKey,
    entry,
    fact.maintenance,
    previousEntry ? Date.now() : -Infinity,
  );
  return {
    ...fact,
    entryCount:
      fact.entryCount === undefined ? undefined : fact.entryCount + (previousEntry ? 0 : 1),
    next: { at: Math.min(at, fact.next.at) },
  };
}

function isMonotoneSessionEntryMaintenanceAgeChange({
  entry,
  previousEntry,
}: SessionEntryMaintenanceAgeChange): boolean {
  return (
    previousEntry !== undefined &&
    previousEntry.archivedAt === undefined &&
    entry.archivedAt === undefined &&
    entry.updatedAt >= previousEntry.updatedAt &&
    getSessionMaintenanceActivityAt(entry) >= getSessionMaintenanceActivityAt(previousEntry)
  );
}

function agePolicy(maintenance: ResolvedSessionMaintenanceConfig): string {
  return JSON.stringify([
    maintenance.pruneAfterMs,
    maintenance.archiveDashboardAfterMs,
    maintenance.preserveRecentMs,
  ]);
}

function nextEntryAgeAt(
  key: string,
  entry: Activity,
  maintenance: ResolvedSessionMaintenanceConfig,
  now: number,
): number {
  if (shouldPreserveMaintenanceEntry({ key, entry: undefined })) {
    return Infinity;
  }
  const activityAt = getSessionMaintenanceActivityAt(entry);
  let next = Infinity;
  for (const [timestamp, age] of [
    [entry?.updatedAt ?? 0, maintenance.pruneAfterMs],
    [activityAt, isDashboardKey(key) ? maintenance.archiveDashboardAfterMs : null],
    [activityAt, maintenance.preserveRecentMs],
  ]) {
    if (timestamp != null) {
      next = Math.min(next, nextAgeAt(timestamp, age, now));
    }
  }
  return next;
}

function nextAgeAt(timestamp: number, age: number | null | undefined, plannedAt: number): number {
  const at = age != null && age > 0 ? timestamp + age + 1 : Infinity;
  return at > plannedAt ? at : Infinity;
}

function readActivityAt(row: {
  updated_at: number;
  last_activity_at: number | null;
  last_interaction_at: number | null;
  session_started_at: number | null;
}): number {
  return getSessionMaintenanceActivityAt({
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? undefined,
    lastInteractionAt: row.last_interaction_at ?? undefined,
    sessionStartedAt: row.session_started_at ?? undefined,
  });
}

/** The caller's transaction keeps these indexed probes in one snapshot. */
export function recordSessionEntryMaintenanceAgeFact(
  database: Pick<OpenClawAgentDatabase, "db">,
  maintenance: ResolvedSessionMaintenanceConfig,
  plannedAt: number,
  entryCount?: number,
): SessionEntryMaintenanceAgeFact {
  const next = { at: Infinity };
  const fact: SessionEntryMaintenanceAgeFact = {
    maintenance,
    entryCount,
    next,
    recheckAt: plannedAt + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  };
  const queries = readSessionMaintenanceAgeQueries(database.db);
  if (maintenance.pruneAfterMs > 0) {
    for (const row of queries.after(plannedAt - maintenance.pruneAfterMs - 1)) {
      if (!shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })) {
        next.at = row.updated_at + maintenance.pruneAfterMs + 1;
        break;
      }
    }
  }
  // Certified keys support indexed namespaces; pending aliases retain the canonical decoder.
  // Older maintenance readers have no pending projection and keep their full row path.
  const dashboardRows = hasCanonicalSessionValidationProjection(database)
    ? [queries.dashboards(undefined), queries.uncertified(undefined)]
    : [queries.activity(undefined)];
  for (const rows of dashboardRows) {
    for (const row of rows) {
      if (
        !isDashboardKey(row.session_key) ||
        shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })
      ) {
        continue;
      }
      next.at = Math.min(
        next.at,
        nextAgeAt(readActivityAt(row), maintenance.archiveDashboardAfterMs, plannedAt),
      );
    }
  }
  const recentAge = maintenance.preserveRecentMs;
  if (recentAge != null && recentAge > 0) {
    for (const row of queries.activity(undefined)) {
      // Activity includes updatedAt, so later indexed rows cannot improve this finite bound.
      if (row.updated_at + recentAge + 1 >= next.at) {
        break;
      }
      if (!shouldPreserveMaintenanceEntry({ key: row.session_key, entry: undefined })) {
        next.at = Math.min(next.at, nextAgeAt(readActivityAt(row), recentAge, plannedAt));
      }
    }
  }
  stageSessionEntryMaintenanceAgeFact(database.db, fact);
  return fact;
}

/** The kick uses the same periodic deadline as inline maintenance callers. */
export function readSessionEntryMaintenanceNextAgeAt(
  database: Pick<OpenClawAgentDatabase, "db">,
  maintenance: ResolvedSessionMaintenanceConfig,
): number | undefined {
  if (maintenance.mode !== "enforce") {
    return undefined;
  }
  const fact = readSessionEntryMaintenanceAgeFact(database.db, maintenance);
  return fact ? Math.min(fact.next.at, fact.recheckAt) : Date.now();
}
