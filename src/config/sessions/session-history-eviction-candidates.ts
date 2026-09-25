import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  collectRecentSessionHistoryIds,
  collectSessionStateIdsForEntry,
} from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { isSessionEntryDiskBudgetEvictable } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type DiskEvictableArchivedSession = {
  archivedAt: number;
  entry: SessionEntry;
  sessionKey: string;
};

const DISK_EVICTABLE_ARCHIVE_BATCH_SIZE = 64;

export function readDiskEvictableArchivedSessionBatch(params: {
  after?: { archivedAt: number; sessionKey: string };
  databaseOptions: OpenClawAgentDatabaseOptions;
  limit?: number;
  preserveRecentMs?: number | null;
}): {
  candidates: DiskEvictableArchivedSession[];
  cursor?: { archivedAt: number; sessionKey: string };
  exhausted: boolean;
} {
  const limit = Math.max(1, params.limit ?? DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
  const candidates: DiskEvictableArchivedSession[] = [];
  let cursor = params.after;
  while (candidates.length < limit) {
    // The agent DB cache may evict idle handles across the caller's async deletion/measurement.
    // Reopen for each bounded page instead of retaining a Kysely handle across those awaits.
    const database = openOpenClawAgentDatabase(params.databaseOptions);
    const db = getSessionKysely(database.db);
    let query = db
      .selectFrom("session_nodes")
      .select(["archived_at", "current_session_id", "entry_json", "session_key", "updated_at"])
      .where("archived_at", "is not", null)
      .orderBy("archived_at", "asc")
      .orderBy("session_key", "asc")
      .limit(DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
    if (cursor) {
      const after = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("archived_at", ">", after.archivedAt),
          eb.and([
            eb("archived_at", "=", after.archivedAt),
            eb("session_key", ">", after.sessionKey),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(database.db, query).rows;
    let scanned = 0;
    for (const row of rows) {
      scanned += 1;
      if (row.archived_at == null) {
        continue;
      }
      cursor = { archivedAt: row.archived_at, sessionKey: row.session_key };
      const entry = parseSessionEntryJson(row);
      if (
        entry &&
        isSessionEntryDiskBudgetEvictable({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
      ) {
        candidates.push({ archivedAt: row.archived_at, entry, sessionKey: row.session_key });
        if (candidates.length >= limit) {
          break;
        }
      }
    }
    const exhausted = rows.length < DISK_EVICTABLE_ARCHIVE_BATCH_SIZE && scanned === rows.length;
    if (candidates.length >= limit || exhausted) {
      return { candidates, ...(cursor ? { cursor } : {}), exhausted };
    }
  }
  return { candidates, ...(cursor ? { cursor } : {}), exhausted: false };
}

/** Resolve a captured admission snapshot without consulting another thread's live owners. */
export function collectSessionAdmissionReferences(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  admissionIdentities: readonly string[];
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  const admissionIdentities = params.admissionIdentities;
  if (admissionIdentities.length === 0) {
    return protectedSessionIds;
  }

  // Admissions may carry either the backing session id or its live session key. Protect both,
  // then resolve admitted keys through their entries so cleanup cannot reclaim active work.
  for (const identity of admissionIdentities) {
    protectedSessionIds.add(identity);
  }
  const normalizedAdmissionKeys = new Set(
    [...admissionIdentities].map((identity) => normalizeStoreSessionKey(identity)),
  );
  const db = getSessionKysely(params.database.db);
  const admittedKeyBytes: string[] = [];
  // Normalize lightweight keys before reading payloads; unrelated saved prompts can be large.
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", db.fn<string>("hex", ["session_key"]).as("key_bytes")]),
  )) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      admittedKeyBytes.push(row.key_bytes);
    }
  }
  const rows = admittedKeyBytes.length
    ? iterateSqliteQuerySync(
        params.database.db,
        db
          .selectFrom("session_nodes")
          .select(["entry_json", "current_session_id"])
          // Keep stored keys inside SQLite: Node TEXT rebinding can change raw UTF-16 keys.
          // The key-only subquery scans the existing index before fetching matched payloads.
          .where(
            "session_key",
            "in",
            db
              .selectFrom("session_nodes")
              .select("session_key")
              .where(
                db.fn<string>("hex", ["session_key"]),
                "in",
                sqliteStringSet(admittedKeyBytes),
              ),
          ),
      )
    : [];
  for (const row of rows) {
    protectedSessionIds.add(row.current_session_id);
    const entry = parseSessionEntryJson(row);
    if (entry) {
      for (const sessionId of collectSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so
  // every generation of an admitted key stays off-limits.
  const generationRows = iterateSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  );
  for (const row of generationRows) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}

export function readHistoricalSessionIdsInDatabase(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  admissionIdentities: readonly string[];
  preserveRecentMs?: number | null;
}): string[] {
  const { database } = params;
  const protectedSessionIds = readReferencedSessionIds(database, undefined, undefined, params);
  for (const sessionId of collectSessionAdmissionReferences(params)) {
    protectedSessionIds.add(sessionId);
  }
  for (const sessionId of collectRecentSessionHistoryIds(params)) {
    protectedSessionIds.add(sessionId);
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .orderBy("updated_at", "asc")
      .orderBy("session_id", "asc"),
  ).rows.flatMap((row) => (protectedSessionIds.has(row.session_id) ? [] : [row.session_id]));
}
