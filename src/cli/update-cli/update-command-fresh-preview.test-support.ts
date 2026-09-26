import { DatabaseSync } from "node:sqlite";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";

export function createSelectedTargetStateDatabase(databasePath: string) {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(databasePath);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
  } finally {
    db.close();
  }
}
