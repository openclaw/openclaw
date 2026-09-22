import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readLegacyCompactionHistory } from "./legacy-compaction-history.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import {
  isRecentSessionMaintenanceEntry,
  isSessionEntryDiskBudgetEvictable,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/**
 * Exactly the code points `String.prototype.trim` removes.
 *
 * SQL prefilters that have to agree with the normalization below pass this to
 * SQLite's `trim(X, Y)`; a test pins the two definitions against each other over
 * the whole code point space so they cannot drift.
 */
export const SESSION_STATE_ID_TRIM_CHARACTERS =
  " \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Every transcript generation retained by one canonical logical-session record. */
export function collectSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  add(entry.previousSessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of readLegacyCompactionHistory(entry)) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

/** Retained logical owners protect generations absent from their entry references. */
export function addRetainedWindowSessionReferences(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: Set<string>,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
  /** Reports the retained owner protecting each id, for callers batching reference analysis. */
  onReference?: (sessionId: string, ownerSessionKey: string) => void,
): void {
  const db = getSessionKysely(database.db);
  // Explicit reset/delete excludes its target owner. Automatic deletion rechecks
  // window ownership inside the commit after archive materialization has awaited.
  let query = db
    .selectFrom("session_windows")
    .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
    .select([
      "session_windows.session_id",
      "session_nodes.session_key",
      "session_nodes.current_session_id",
      "session_nodes.updated_at",
      "session_nodes.pinned_at",
    ])
    .$if(diskBudget !== undefined, (projection) => projection.select(sessionEntryMetadataJson))
    .where((eb) =>
      eb.or([
        eb("session_nodes.archived_at", "is not", null),
        eb("session_nodes.pinned_at", "is not", null),
      ]),
    );
  if (candidateSessionIds) {
    query = query.where("session_windows.session_id", "in", sqliteStringSet(candidateSessionIds));
  }
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    // Only the physical-budget owner may reclaim cap-created history. Node references
    // (including the current generation) remain protected until its final entry tier.
    if (
      diskBudget &&
      row.pinned_at === null &&
      row.entry_json !== undefined &&
      isSessionEntryDiskBudgetEvictable({
        key: row.session_key,
        entry: parseSessionEntryJson({ ...row, entry_json: row.entry_json }) ?? undefined,
        preserveRecentMs: diskBudget.preserveRecentMs,
      })
    ) {
      continue;
    }
    sessionIds.add(row.session_id);
    onReference?.(row.session_id, row.session_key);
  }
}

export function collectRecentSessionHistoryIds(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
}): Set<string> {
  if (params.preserveRecentMs == null) {
    return new Set();
  }
  const db = getNodeSqliteKysely<
    Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows"> & {
      pragma_encoding: { encoding: string };
    }
  >(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.session_key",
        "session_nodes.updated_at",
        "session_windows.session_id",
      ])
      .select((eb) =>
        // UTF-16 JSON projection can change identity code points; retain its original TEXT.
        eb
          .case()
          .when(eb(eb.selectFrom("pragma_encoding").select("encoding"), "=", "UTF-8"))
          .then(sessionEntryMetadataJson.expression)
          .else(eb.ref("session_nodes.entry_json"))
          .end()
          .as("entry_json"),
      ),
  ).rows;
  return new Set(
    rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry &&
        isRecentSessionMaintenanceEntry({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
        ? [row.session_id]
        : [];
    }),
  );
}

export function isRecentHistoricalSessionId(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  sessionId: string;
}): boolean {
  if (params.preserveRecentMs == null) {
    return false;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.session_key",
        "session_nodes.updated_at",
      ])
      .where("session_windows.session_id", "=", params.sessionId),
  ).rows[0];
  if (!row) {
    return false;
  }
  const entry = parseSessionEntryJson(row);
  return Boolean(
    entry &&
    isRecentSessionMaintenanceEntry({
      key: row.session_key,
      entry,
      preserveRecentMs: params.preserveRecentMs,
    }),
  );
}
