import { createHash } from "node:crypto";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload-read.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import type { DeferredSessionTranscriptReadOperations } from "./deferred-plugin-session-source-recovery.worker-contract.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";
import { openSqliteReadOnlyDatabase } from "./sqlite-snapshot-source.js";

export const deferredSessionTranscriptReadOperations = {
  "deferredSessionImport.verifyMissingTranscript": (
    input: DeferredSessionTranscriptReadOperations["deferredSessionImport.verifyMissingTranscript"]["input"],
    context: SqliteReadOnlyOperationContext,
  ): boolean => {
    // The read scope owns an artifact-preserving snapshot of the receipt-bound database.
    const db = openSqliteReadOnlyDatabase(context.path);
    try {
      const query = getNodeSqliteKysely<Pick<DB, "transcript_events">>(db);
      const hash = createHash("sha256");
      let bytes = 0;
      for (const row of iterateSqliteQuerySync(
        db,
        query
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(db).as("event_json"))
          .where("session_id", "=", input.sessionId)
          .orderBy("seq", "asc"),
      )) {
        const line = `${row.event_json}\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > input.identity.size) {
          return false;
        }
        hash.update(line);
        if (bytes === input.identity.size) {
          return hash.digest("hex") === input.identity.sha256;
        }
      }
      return false;
    } finally {
      db.close();
    }
  },
};
