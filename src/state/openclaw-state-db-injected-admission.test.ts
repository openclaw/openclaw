import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

it("discovers the ownership table for an injected handle at transaction admission", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-injected-admission-") } };
  const pathname = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  const { constants, DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  let schemaReads = 0;
  db.setAuthorizer((actionCode, tableName) => {
    if (actionCode === constants.SQLITE_READ && tableName === "sqlite_master") {
      schemaReads += 1;
    }
    return constants.SQLITE_OK;
  });

  try {
    runOpenClawStateWriteTransaction(() => undefined, {
      ...options,
      database: {
        db,
        path: pathname,
        walMaintenance: {
          checkpoint: () => false,
          close: () => false,
          reclaimFreePages: createSqliteWalReclamationResult,
        },
      },
    });
  } finally {
    db.setAuthorizer(null);
    db.close();
  }

  expect(schemaReads).toBe(4);
});
