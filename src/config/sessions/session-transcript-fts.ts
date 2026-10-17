import { sql } from "kysely";
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
import { TRANSCRIPT_INSERT_BATCH_SIZE } from "./transcript-payload.js";

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
  const postgres = isPostgresSqlConnection(db);
  const search = postgres ? undefined : admitStoreSearch(db, agentTranscriptSearchSchema);
  if (search && !search.fullText) {
    throw new Error(search.diagnostics.join("; "));
  }
  const prepare = (count: number) => {
    const indexes = Array.from({ length: count }, (_, index) => index);
    const insertContent = prepareSqliteQuerySync<readonly TranscriptFtsEntry[]>(db, (parameter) => {
      const entries = kysely.with(
        "entries(position, message_id, text, role, timestamp)",
        () =>
          /* kysely-allow-raw: A bounded VALUES relation carries entry order and natural keys with the content. */
          sql<{
            position: number;
            message_id: string | null;
            text: string | null;
            role: string | null;
            timestamp: number | string | null;
          }>`(values ${sql.join(indexes.map((index) => sql`(${sql.lit(index)}, ${parameter((rows) => rows[index]!.messageId)}, ${parameter((rows) => rows[index]!.text)}, ${parameter((rows) => rows[index]!.role)}, ${parameter((rows) => rows[index]!.timestamp)})`))})`,
      );
      if (postgres) {
        return entries
          .with("inserted", (query) =>
            query
              .insertInto("session_transcript_fts_rows")
              .columns(["session_id", "message_id"])
              .expression((source) =>
                source
                  .selectFrom("entries")
                  .select((eb) => [eb.val(sessionId).as("session_id"), "message_id"])
                  .orderBy("position"),
              )
              .returning(["id", "message_id"]),
          )
          .insertInto("session_transcript_fts")
          .columns(["rowid", "text", "session_id", "message_id", "role", "timestamp"])
          .expression((query) =>
            query
              .selectFrom("inserted")
              .innerJoin("entries", (join) =>
                join.onRef("entries.message_id", "is not distinct from", "inserted.message_id"),
              )
              .select((eb) => [
                "id",
                "entries.text",
                eb.val(sessionId).as("session_id"),
                "entries.message_id",
                "entries.role",
                eb.cast<number>("entries.timestamp", "double precision").as("timestamp"),
              ])
              .orderBy("entries.position"),
          );
      }
      return entries
        .with(
          (cte) => cte("allocated").materialized(),
          (query) =>
            query.selectNoFrom(
              search!.fullText!.allocatedIdentity(search!.text.transcript!).as("last_id"),
            ),
        )
        .insertInto("session_transcript_fts")
        .columns(["rowid", "text", "session_id", "message_id", "role", "timestamp"])
        .expression((query) =>
          query
            .selectFrom("entries")
            .crossJoin("allocated")
            .select((eb) => [
              // Below INT64_MAX, SQLite allocates consecutive IDs. Capture before FTS5
              // changes last_insert_rowid; all 64-bit arithmetic stays in SQLite.
              eb(
                eb("allocated.last_id", "-", sql.lit(count - 1)),
                "+",
                eb.ref("entries.position"),
              ).as("rowid"),
              "entries.text",
              eb.val(sessionId).as("session_id"),
              "entries.message_id",
              "entries.role",
              "entries.timestamp",
            ])
            .orderBy("entries.position"),
        );
    });
    if (postgres) {
      return insertContent;
    }
    const insertIdentities = prepareSqliteQuerySync<readonly TranscriptFtsEntry[]>(
      db,
      (parameter) =>
        kysely.insertInto("session_transcript_fts_rows").values(
          indexes.map((index) => ({
            session_id: sessionId,
            message_id: parameter((entries) => entries[index]!.messageId),
          })),
        ),
    );
    return (entries: readonly TranscriptFtsEntry[]) => {
      insertIdentities(entries);
      insertContent(entries);
    };
  };
  const inserts = new Map<number, ReturnType<typeof prepare>>();
  return (entries: readonly TranscriptFtsEntry[]): void => {
    withSqliteDatabaseWriteScope(db, [sqliteSessionIdWriteScope(sessionId)], () => {
      for (let offset = 0; offset < entries.length;) {
        const keys = new Set<string | null>();
        const start = offset;
        // At most 4 * 64 + 2 binds, below both engines' limits. Split repeated keys
        // (including null) so the PG RETURNING join has exactly one content row.
        while (
          offset < entries.length &&
          offset - start < TRANSCRIPT_INSERT_BATCH_SIZE &&
          !keys.has(entries[offset]!.messageId)
        ) {
          keys.add(entries[offset++]!.messageId);
        }
        const chunk = entries.slice(start, offset);
        const write = inserts.get(chunk.length) ?? prepare(chunk.length);
        inserts.set(chunk.length, write);
        write(chunk);
      }
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
