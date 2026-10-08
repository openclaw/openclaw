import type { DatabaseSync } from "node:sqlite";
import { deleteSessionTranscriptFtsRowsInTransaction } from "../config/sessions/session-transcript-fts.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";
import { backupDoctorSqliteRepair } from "./sqlite-index-recovery.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

/** Doctor alone may remove windows whose logical node no longer exists. */
export function repairDoctorSessionWindowOrphans(
  database: DatabaseSync,
  pathname: string,
  assertCurrent: () => void,
): string[] {
  assertCurrent();
  if (database.isTransaction) {
    throw new Error("Session window repair requires its own maintenance transaction.");
  }
  database.exec("PRAGMA foreign_keys = ON;");
  let backupPath: string | undefined;
  try {
    return runSqliteImmediateTransactionSync(
      database,
      () => {
        assertCurrent();
        let orphans = 0;
        const foreignKeys = database.prepare("PRAGMA foreign_key_check");
        foreignKeys.setReadBigInts(true);
        for (const violation of foreignKeys.iterate()) {
          if (violation.table !== "session_windows" || violation.parent !== "session_nodes") {
            return [];
          }
          orphans += 1;
        }
        if (orphans === 0) {
          return [];
        }
        backupPath = backupDoctorSqliteRepair(pathname, "session-window");
        assertCurrent();
        const db = getNodeSqliteKysely<DB>(database);
        const windows = db
          .selectFrom("session_windows")
          .leftJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
          .where("session_nodes.session_key", "is", null)
          .select("session_windows.session_id");
        // FTS is virtual and has no FK cascade; its existing owner clears derived rows.
        for (const window of iterateSqliteQuerySync(database, windows)) {
          deleteSessionTranscriptFtsRowsInTransaction(database, window.session_id);
        }
        executeSqliteQuerySync(
          database,
          db.deleteFrom("session_windows").where("session_id", "in", windows),
        );
        assertSqliteIntegrity(database, pathname);
        return [
          `Saved pre-repair SQLite backup: ${backupPath}`,
          `Removed ${orphans} orphan session window(s) from ${pathname}; their dependent history remains in the backup.`,
        ];
      },
      {
        databaseLabel: pathname,
        operationLabel: "session.orphan-window-repair",
        withCommit: (commit) => {
          assertCurrent();
          commit();
        },
      },
    );
  } catch (cause) {
    if (!backupPath) {
      throw cause;
    }
    throw new Error(`Session window repair failed; original database preserved at ${backupPath}.`, {
      cause,
    });
  }
}
