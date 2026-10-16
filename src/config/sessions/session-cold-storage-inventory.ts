import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export function readSessionColdStorageInventory(database?: { db: DatabaseSync; path: string }) {
  if (!database) {
    return { hotTranscripts: 0, coldTranscripts: 0, embeddedArchiveBytes: 0 };
  }
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getNodeSqliteKysely<DB>(database.db);
      const cold = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_cold_archives")
          .select((eb) => [
            eb.fn.countAll<number>().as("count"),
            eb.fn.sum<number>("archive_bytes").filterWhere("storage", "=", "sqlite").as("bytes"),
          ]),
      );
      return {
        hotTranscripts:
          executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_windows as window")
              .leftJoin(
                "session_transcript_cold_archives as cold",
                "cold.session_id",
                "window.session_id",
              )
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where("cold.session_id", "is", null)
              .where((eb) =>
                eb.exists(
                  eb
                    .selectFrom("transcript_events as event")
                    .select("event.seq")
                    .whereRef("event.session_id", "=", "window.session_id"),
                ),
              ),
          )?.count ?? 0,
        embeddedArchiveBytes: cold?.bytes ?? 0,
        coldTranscripts: cold?.count ?? 0,
      };
    },
    { databaseLabel: database.path, operationLabel: "session cold storage inventory" },
  );
}
