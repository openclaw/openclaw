import type { DatabaseSync } from "node:sqlite";
import type { ColumnType, Generated } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

type FtsDatabase = Pick<DB, "session_transcript_fts_rows" | "session_transcript_index_state"> & {
  session_transcript_fts: Omit<DB["session_transcript_fts"], "timestamp"> & {
    rowid: Generated<number>;
    timestamp: ColumnType<string | number | null, string | number | null, string | number | null>;
  };
};
type FtsRow = Omit<DB["session_transcript_fts"], "session_id" | "timestamp"> & {
  timestamp: string | number | null;
};

/** FTS5 RETURNING does not expose the assigned rowid; capture last_insert_rowid immediately. */
export function createSessionTranscriptFtsInserter(db: DatabaseSync, sessionId: string) {
  const kysely = getNodeSqliteKysely<FtsDatabase>(db);
  const insert = prepareSqliteQuerySync<FtsRow>(db, (parameter) =>
    kysely.insertInto("session_transcript_fts").values({
      session_id: sessionId,
      text: parameter((row) => row.text),
      message_id: parameter((row) => row.message_id),
      role: parameter((row) => row.role),
      timestamp: parameter((row) => row.timestamp),
    }),
  );
  const record = kysely
    .insertInto("session_transcript_fts_rows")
    .values({
      session_id: sessionId,
      fts_rowid: kysely.fn<number>("last_insert_rowid", []),
    })
    .compile();
  const increment = kysely
    .updateTable("session_transcript_index_state")
    .set((eb) => ({ fts_row_count: eb("fts_row_count", "+", 1) }))
    .where("session_id", "=", sessionId)
    .compile();
  return (row: FtsRow): void => {
    insert(row);
    executeSqliteQuerySync(db, { compile: () => record });
    executeSqliteQuerySync(db, { compile: () => increment });
  };
}

export function hasCompleteSessionTranscriptFtsRows(db: DatabaseSync, sessionId: string): boolean {
  const kysely = getNodeSqliteKysely<FtsDatabase>(db);
  const state = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("session_transcript_index_state")
      .select([
        "fts_row_count",
        (eb) =>
          eb
            .selectFrom("session_transcript_fts_rows")
            .select((count) => count.fn.countAll<number>().as("count"))
            .where("session_id", "=", sessionId)
            .as("mapped_count"),
      ])
      .where("session_id", "=", sessionId),
  );
  return (
    state !== undefined &&
    state.fts_row_count !== null &&
    state.fts_row_count === state.mapped_count
  );
}

/** Keeps exact row ownership and its completeness fact in the caller's write transaction. */
export function deleteSessionTranscriptFtsRows(
  db: DatabaseSync,
  sessionId: string,
  options: { limit?: number; messageIds?: readonly string[]; mappingComplete?: boolean } = {},
): number {
  const kysely = getNodeSqliteKysely<FtsDatabase>(db);
  const complete = options.mappingComplete ?? hasCompleteSessionTranscriptFtsRows(db, sessionId);
  if (!complete && options.limit === undefined && options.messageIds === undefined) {
    return deleteLegacySessionTranscriptFtsRows(db, [sessionId]);
  }
  let mapped = kysely
    .selectFrom("session_transcript_fts_rows")
    .select("fts_rowid")
    .where("session_id", "=", sessionId);
  if (options.limit !== undefined && options.messageIds === undefined) {
    // Bound the IN input too: an outer LIMIT alone materializes every mapped rowid.
    mapped = mapped.limit(options.limit);
  }
  let query = kysely.selectFrom("session_transcript_fts").select("rowid");
  query = complete ? query.where("rowid", "in", mapped) : query.where("session_id", "=", sessionId);
  if (options.messageIds) {
    query = query.where(
      "message_id",
      "in",
      options.messageIds.length <= 400 ? options.messageIds : sqliteStringSet(options.messageIds),
    );
  }
  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }
  const partial = options.limit !== undefined || options.messageIds !== undefined;
  // Materialize only bounded chunks/suffixes: deleting FTS rows would otherwise change
  // the selection used to remove their mappings. Whole-session deletes need no row array.
  const rowids = partial
    ? complete && options.messageIds === undefined
      ? executeSqliteQuerySync(db, mapped).rows.map((row) => row.fts_rowid)
      : executeSqliteQuerySync(db, query).rows.map((row) => row.rowid)
    : undefined;
  const deletion = kysely.deleteFrom("session_transcript_fts");
  const removeMappings = kysely
    .deleteFrom("session_transcript_fts_rows")
    .where("session_id", "=", sessionId);
  let consumed: number;
  if (rowids) {
    // Large suffixes must stay below both SQLite's variable and JS argument limits.
    for (let offset = 0; offset < rowids.length; offset += 400) {
      const batch = rowids.slice(offset, offset + 400);
      executeSqliteQuerySync(db, deletion.where("rowid", "in", batch));
      executeSqliteQuerySync(db, removeMappings.where("fts_rowid", "in", batch));
    }
    // Consume dangling mappings too, so worker progress survives missing FTS content.
    consumed = rowids.length;
  } else {
    consumed = Number(
      executeSqliteQuerySync(
        db,
        complete
          ? deletion.where("rowid", "in", mapped)
          : deletion.where("session_id", "=", sessionId),
      ).numAffectedRows ?? 0n,
    );
  }
  const exhausted = !partial || (options.limit !== undefined && consumed < options.limit);
  if (exhausted) {
    executeSqliteQuerySync(db, removeMappings);
  }
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("session_transcript_index_state")
      .set((eb) => ({
        fts_row_count: exhausted ? 0 : complete ? eb("fts_row_count", "-", consumed) : null,
      }))
      .where("session_id", "=", sessionId),
  );
  return consumed;
}

/** Migrated cold-archive batches retain one fallback scan for all unknown sessions. */
export function deleteLegacySessionTranscriptFtsRows(
  db: DatabaseSync,
  sessionIds: readonly string[],
): number {
  const kysely = getNodeSqliteKysely<FtsDatabase>(db);
  const ids = sessionIds.length <= 400 ? sessionIds : sqliteStringSet(sessionIds);
  const deleted = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("session_transcript_fts").where("session_id", "in", ids),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("session_transcript_fts_rows").where("session_id", "in", ids),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("session_transcript_index_state")
      .set({ fts_row_count: 0 })
      .where("session_id", "in", ids),
  );
  return Number(deleted.numAffectedRows ?? 0n);
}
