import type { DatabaseSync } from "node:sqlite";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getSessionMaintenanceActivityAt,
  shouldPreserveMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type AgeFact = {
  maintenance: ResolvedSessionMaintenanceConfig;
  next: { at: number };
  recheckAt: number;
};
type Activity = Parameters<typeof getSessionMaintenanceActivityAt>[0];

export const SESSION_ENTRY_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1_000;

// Ordinary writes only make entries younger or remove them, so this lower bound
// survives entry-cache revision churn. Every maintenance caller enforces the
// recheck deadline, including callers that do not register a maintenance kick.
const ageFacts = new WeakMap<DatabaseSync, AgeFact>();

function stageAgeFact(db: DatabaseSync, fact: AgeFact): void {
  if (
    stageSqliteTransactionState(db, {
      stage: () => ageFacts.set(db, fact),
      rollback: () => ageFacts.delete(db),
      commit: () => {},
    })
  ) {
    return;
  }
  if (!db.isTransaction) {
    ageFacts.set(db, fact);
  }
}

export function invalidateSessionEntryMaintenanceAgeFact(db: DatabaseSync): void {
  ageFacts.delete(db);
}

export function readSessionEntryMaintenanceAgeFact(
  db: DatabaseSync,
  maintenance: ResolvedSessionMaintenanceConfig,
): AgeFact | undefined {
  const fact = ageFacts.get(db);
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
  update: { sessionKey: string; entry: SessionEntry; previousEntry?: SessionEntry },
): void {
  const fact = ageFacts.get(db);
  if (!fact || update.entry.archivedAt !== undefined) {
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
  if (at < fact.next.at) {
    stageAgeFact(db, { ...fact, next: { at } });
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

/** Plan facts use one timestamp projection; prompt payloads never enter JavaScript. */
export function recordSessionEntryMaintenanceAgeFact(
  database: OpenClawAgentDatabase,
  maintenance: ResolvedSessionMaintenanceConfig,
  plannedAt: number,
): void {
  const next = { at: Infinity };
  const fact: AgeFact = {
    maintenance,
    next,
    recheckAt: plannedAt + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
  };
  const query = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_nodes">>(database.db)
    .selectFrom("session_nodes")
    .select(["session_key", "updated_at", "last_activity_at", "last_interaction_at"])
    .select((eb) =>
      eb
        .case()
        .when(eb.fn<number>("json_valid", ["entry_json"]), "=", 1)
        .then(
          eb.cast<number>(
            eb.fn("json_extract", [eb.ref("entry_json"), eb.val("$.sessionStartedAt")]),
            "integer",
          ),
        )
        .else(null)
        .end()
        .as("session_started_at"),
    )
    .where("archived_at", "is", null);
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    const activity = {
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at ?? undefined,
      lastInteractionAt: row.last_interaction_at ?? undefined,
      sessionStartedAt: row.session_started_at ?? undefined,
    };
    // Keep only transitions after plan start, including ones crossed while planning.
    // Already-aged protected entries wait for the periodic recheck.
    next.at = Math.min(next.at, nextEntryAgeAt(row.session_key, activity, maintenance, plannedAt));
  }
  stageAgeFact(database.db, fact);
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
