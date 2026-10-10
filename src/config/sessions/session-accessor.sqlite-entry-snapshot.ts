import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  readExactSessionEntryRow,
  readSessionEntryRowScan,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import type {
  SessionEntryWindowFacts,
  SessionEntryWindowRow,
} from "./session-accessor.sqlite-provenance.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Exact reads already own nested values; retain them through identity publication. */
export function readSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, row.entry);
    }
  }
  return snapshot;
}

// Runtime patches own only the exact canonical row. Folded lookup candidates
// can be distinct case-sensitive rooms and must not join its mutation snapshot.
export function readSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
  includeWindowFacts?: true,
): SqliteLifecycleTargetSnapshot {
  const scanned = exact
    ? undefined
    : readSessionEntryRowScan(database, sessionKey, includeWindowFacts);
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey, "full", undefined, includeWindowFacts)
    : scanned?.selected;
  return selected
    ? [
        captureSessionEntrySnapshot(
          database,
          selected,
          scanned?.lookupKeys ?? [sessionKey.trim()],
          scanned?.rows ?? [selected.row],
        ),
      ]
    : [];
}

export function captureSessionEntrySnapshot(
  database: Pick<OpenClawAgentDatabase, "db">,
  selected: ResolvedSessionEntryRow,
  lookupKeys: readonly string[],
  rows: readonly ResolvedSessionEntryRow["row"][],
): SqliteLifecycleTargetSnapshot[number] {
  let window: SessionEntryWindowFacts | undefined;
  if (selected.row.window_json !== undefined) {
    const revision = readSqliteNativeMutationRevision(database.db);
    if (revision !== undefined) {
      let row: SessionEntryWindowRow | null = null;
      if (selected.row.window_json) {
        // SAFETY: The SQLite JSON subquery serializes this owner's typed scalar projection.
        row = JSON.parse(selected.row.window_json) as SessionEntryWindowRow;
      }
      window = {
        database: database.db,
        revision,
        sessionId: selected.row.current_session_id,
        row,
      };
    }
  }
  return {
    entry: selected.entry,
    sessionKey: selected.row.session_key,
    ...(window ? { window } : {}),
    ...(selected.row.member_ids_json !== undefined && selected.row.board_present !== undefined
      ? {
          sideTables: {
            memberIdsJson: selected.row.member_ids_json,
            hasBoard: selected.row.board_present === 1,
          },
        }
      : {}),
    persistedRows: {
      lookupKeys,
      rows: rows.map(retainSessionEntryRowFacts),
    },
  };
}

// The node's snapshot revision fences cold changes without retaining their bytes twice.
function retainSessionEntryRowFacts(row: ResolvedSessionEntryRow["row"]) {
  delete row.session_diff_baseline_json;
  delete row.skills_snapshot_json;
  delete row.system_prompt_report_json;
  delete row.window_json;
  delete row.member_ids_json;
  delete row.board_present;
  return row;
}

/** Reuses preparation only when every persisted column still matches; otherwise hydrate. */
export function readUnchangedLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  prepared: SqliteLifecycleTargetSnapshot,
): SqliteLifecycleTargetSnapshot | undefined {
  const persisted = prepared[0]?.persistedRows;
  if (!persisted || persisted.lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_nodes")
      .selectAll()
      .where("session_key", "in", sqliteStringSet(persisted.lookupKeys))
      .orderBy("session_key", "asc"),
  ).rows;
  // Worker transport reconstructs SQLite's null-prototype rows as ordinary objects.
  return isDeepStrictEqual(rows, persisted.rows, { skipPrototype: true }) ? prepared : undefined;
}
