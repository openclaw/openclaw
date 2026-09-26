import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionMaintenanceAgeQueries } from "./session-accessor.sqlite-maintenance-age-queries.js";
import { hasCanonicalSessionValidationProjection } from "./session-canonical-key.js";
import {
  getSessionMaintenanceActivityAt,
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryMaintenanceAgeFact = {
  maintenance: ResolvedSessionMaintenanceConfig;
  next: { at: number };
  recheckAt: number;
};
export type SessionEntryMaintenanceAgeCapture = { fact?: SessionEntryMaintenanceAgeFact };

type Activity = Parameters<typeof getSessionMaintenanceActivityAt>[0];

export const SESSION_ENTRY_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1_000;

// Ordinary updates retain this age lower bound across entry-cache revision churn.
// New active entries rotate the capture so in-flight count decisions observe them.
// Maintenance readers enforce the recheck deadline, including paths without a kick.
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

/** Capture identity stays local; only its scalar fact crosses the Worker boundary. */
export function captureSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  maintenance: ResolvedSessionMaintenanceConfig,
): SessionEntryMaintenanceAgeCapture {
  readSessionEntryMaintenanceAgeFact(db, maintenance);
  let capture = ageFacts.get(db);
  if (!capture) {
    capture = {};
    ageFacts.set(db, capture);
  }
  return capture;
}

export function isSessionEntryMaintenanceAgeCaptureCurrent(
  db: DatabaseSync,
  capture: SessionEntryMaintenanceAgeCapture,
): boolean {
  return ageFacts.get(db) === capture;
}

export function adoptSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  capture: SessionEntryMaintenanceAgeCapture,
  fact: SessionEntryMaintenanceAgeFact | undefined,
): void {
  // A synchronous writer can run after native commit but before parent settlement.
  // Keep its newer state without turning an already committed result into failure.
  if (isSessionEntryMaintenanceAgeCaptureCurrent(db, capture)) {
    capture.fact = fact;
  }
}

function isDashboardKey(key: string): boolean {
  return parseAgentSessionKey(key)?.rest.startsWith("dashboard:") === true;
}

/** Tracked writes can only bring the conservative age boundary forward. */
export function advanceSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  update: { sessionKey: string; entry: SessionEntry; previousEntry?: SessionEntry },
): void {
  const fact = ageFacts.get(db)?.fact;
  if (!fact) {
    // An empty capture must also observe writes while Worker results are in flight.
    invalidateSessionEntryMaintenanceAgeFact(db);
    return;
  }
  if (update.entry.archivedAt !== undefined) {
    return;
  }
  const { entry, previousEntry } = update;
  if (
    previousEntry &&
    (previousEntry.archivedAt !== undefined ||
      entry.updatedAt < previousEntry.updatedAt ||
      getSessionMaintenanceActivityAt(entry) < getSessionMaintenanceActivityAt(previousEntry))
  ) {
    // Exact replacement/lifecycle writers also own backdates and archive restores.
    invalidateSessionEntryMaintenanceAgeFact(db);
    return;
  }
  // A newly inserted historical entry must retain already-due transitions too.
  const at = nextEntryAgeAt(
    update.sessionKey,
    entry,
    fact.maintenance,
    previousEntry ? Date.now() : -Infinity,
  );
  if (!previousEntry || at < fact.next.at) {
    stageSessionEntryMaintenanceAgeFact(db, { ...fact, next: { at: Math.min(at, fact.next.at) } });
  }
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
    if (timestamp != null && age != null && age > 0) {
      const at = timestamp + age + 1;
      if (at > now) {
        next = Math.min(next, at);
      }
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
): SessionEntryMaintenanceAgeFact {
  const next = { at: Infinity };
  const fact: SessionEntryMaintenanceAgeFact = {
    maintenance,
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
  database: OpenClawAgentDatabase,
  maintenance: ResolvedSessionMaintenanceConfig,
): number | undefined {
  if (maintenance.mode !== "enforce") {
    return undefined;
  }
  const fact = readSessionEntryMaintenanceAgeFact(database.db, maintenance);
  return fact ? Math.min(fact.next.at, fact.recheckAt) : Date.now();
}
