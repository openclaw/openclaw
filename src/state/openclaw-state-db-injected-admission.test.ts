import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

it("keeps a raw handle to a cached database on conservative ownership admission", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-injected-admission-") } };
  const pathname = openOpenClawStateDatabase(options).path;
  const { constants, DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  let schemaReads = 0;
  db.setAuthorizer((actionCode, tableName) => {
    if (actionCode === constants.SQLITE_READ && tableName === "sqlite_master") {
      schemaReads += 1;
    }
    return constants.SQLITE_OK;
  });

  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    runOpenClawStateWriteTransaction(() => undefined, {
      ...options,
      database: {
        db,
        path: pathname,
        walMaintenance: {
          stop: async () => {},
          checkpoint: () => false,
          close: () => false,
          reclaimFreePages: createSqliteWalReclamationResult,
        },
      },
    });
    expect(
      reads.queries.filter((sql) => sql.includes("SELECT value_json FROM config_machine_state")),
    ).toEqual([
      "SELECT value_json FROM config_machine_state NOT INDEXED WHERE state_key = ? LIMIT 1",
    ]);
  } finally {
    reads.restore();
    db.setAuthorizer(null);
    db.close();
  }

  expect(schemaReads).toBe(2);
});
