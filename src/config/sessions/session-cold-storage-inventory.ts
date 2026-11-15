import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { SessionStoreReadCustody } from "./session-store-read-candidates.js";
import type { SessionColdMetadataWorkerResult } from "./session-transcript-inventory.types.js";

export function readSessionColdStorageInventory(database?: { db: EngineConnection; path: string }) {
  if (!database) {
    return { hotTranscripts: 0, coldTranscripts: 0, embeddedArchiveBytes: 0 };
  }
  return runSqliteReadSnapshotSync(
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

export function readSessionColdMetadataInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  readCustody?: readonly SessionStoreReadCustody[],
): SessionColdMetadataWorkerResult {
  const archive = readSessionColdTranscript(database.db, sessionId);
  if (!archive) {
    return { kind: "cold-metadata", archive: undefined };
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const readIdentity = {
    key: `file:${identity.identity}`,
    canonicalPath: identity.canonicalPath,
    birthtime: identity.birthtime,
  };
  return {
    kind: "cold-metadata",
    archive,
    source: {
      readIdentity,
      readCustody: readCustody ?? [
        {
          sourcePath: database.path,
          candidates: [
            { path: database.path, physicalPath: identity.canonicalPath, identity: readIdentity },
          ],
        },
      ],
    },
  };
}
