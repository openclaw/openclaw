import { admitStoreSearch } from "../../infra/database-engine/adapters.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { agentTranscriptSearchSchema } from "../../state/openclaw-agent-search-schema.js";

type TranscriptFtsDatabase = Pick<DB, "session_transcript_fts_rows"> & {
  session_transcript_fts: Omit<DB["session_transcript_fts"], "timestamp"> & {
    rowid: number;
    timestamp: number | string | null;
  };
};

type TranscriptFtsEntry = {
  messageId: string | null;
  text: string | null;
  role: string | null;
  timestamp: number | string | null;
};

/** Insert both projection records in the caller's synchronous write transaction. */
export function createSessionTranscriptFtsInserter(db: EngineConnection, sessionId: string) {
  const kysely = getNodeSqliteKysely<TranscriptFtsDatabase>(db);
  if (isPostgresSqlConnection(db)) {
    const insert = prepareSqliteQuerySync<TranscriptFtsEntry>(db, (parameter) =>
      kysely
        .with("inserted", (query) =>
          query
            .insertInto("session_transcript_fts_rows")
            .values({
              session_id: sessionId,
              message_id: parameter((entry) => entry.messageId),
            })
            .returning("id"),
        )
        .insertInto("session_transcript_fts")
        .columns(["rowid", "text", "session_id", "message_id", "role", "timestamp"])
        .expression((query) =>
          query
            .selectFrom("inserted")
            .select((eb) => [
              "id",
              parameter((entry) => entry.text).as("text"),
              eb.val(sessionId).as("session_id"),
              parameter((entry) => entry.messageId).as("message_id"),
              parameter((entry) => entry.role).as("role"),
              parameter((entry) => entry.timestamp).as("timestamp"),
            ]),
        ),
    );
    return (entry: TranscriptFtsEntry): void => {
      withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () => insert(entry));
    };
  }
  const search = admitStoreSearch(db, agentTranscriptSearchSchema);
  if (!search.fullText) {
    throw new Error(search.diagnostics.join("; "));
  }
  const insertIdentity = prepareSqliteQuerySync<TranscriptFtsEntry>(db, (parameter) =>
    kysely.insertInto("session_transcript_fts_rows").values({
      session_id: sessionId,
      message_id: parameter((entry) => entry.messageId),
    }),
  );
  const insertContent = prepareSqliteQuerySync<TranscriptFtsEntry>(db, (parameter) =>
    kysely.insertInto("session_transcript_fts").values({
      // Keep the allocated 64-bit identity inside SQLite, including above JS's safe integer range.
      rowid: search.fullText!.allocatedIdentity(search.text.transcript!),
      text: parameter((entry) => entry.text),
      session_id: sessionId,
      message_id: parameter((entry) => entry.messageId),
      role: parameter((entry) => entry.role),
      timestamp: parameter((entry) => entry.timestamp),
    }),
  );
  return (entry: TranscriptFtsEntry): void => {
    withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () => {
      insertIdentity(entry);
      insertContent(entry);
    });
  };
}

/** Indexed identities select the work; their delete trigger removes the matching FTS rows. */
export function deleteSessionTranscriptFtsRowsInTransaction(
  db: EngineConnection,
  sessionIds: string | readonly string[],
  options: { messageIds?: readonly string[]; maxRows?: number } = {},
): number {
  const kysely = getNodeSqliteKysely<TranscriptFtsDatabase>(db);
  let selected = kysely.selectFrom("session_transcript_fts_rows").select("id");
  selected =
    typeof sessionIds === "string"
      ? selected.where("session_id", "=", sessionIds)
      : selected.where("session_id", "in", sqliteStringSet(sessionIds));
  if (options.messageIds) {
    selected = selected.where(
      "message_id",
      "in",
      options.messageIds.length <= 400 ? options.messageIds : sqliteStringSet(options.messageIds),
    );
  }
  if (options.maxRows !== undefined) {
    selected = selected.limit(options.maxRows);
  }
  return Number(
    withSqliteDatabaseWriteScope(
      db,
      (typeof sessionIds === "string" ? [sessionIds] : sessionIds).map(sqliteSessionIdWriteScope),
      () =>
        executeSqliteQuerySync(
          db,
          kysely.deleteFrom("session_transcript_fts_rows").where("id", "in", selected),
        ).numAffectedRows,
    ) ?? 0n,
  );
}

/** Stream only one session's FTS content without scanning other sessions' payloads. */
export function selectSessionTranscriptFtsRows(db: EngineConnection, sessionId: string) {
  const kysely = getNodeSqliteKysely<TranscriptFtsDatabase>(db);
  return kysely
    .selectFrom("session_transcript_fts")
    .select(["text", "message_id", "role", "timestamp"])
    .where(
      "rowid",
      "in",
      kysely
        .selectFrom("session_transcript_fts_rows")
        .select("id")
        .where("session_id", "=", sessionId),
    )
    .orderBy("rowid");
}
