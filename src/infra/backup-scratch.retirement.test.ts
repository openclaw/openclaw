import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createBackupScratchDirectory as createScratch,
  finishBackupScratch as finishScratch,
} from "./backup-scratch.js";
import * as sqlite from "./node-sqlite.js";
import * as tokens from "./sqlite-staging-token.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps scratch custody while retiring against a competing reclaimer", async () => {
  const root = dirs.make("backup-scratch-retirement-custody-");
  const open = sqlite.openNodeSqliteDatabase;
  let interpose = () => {};
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
    const database = open(...args);
    const exec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "ROLLBACK") {
        interpose();
      }
    });
    return database;
  });
  const scratch = await createScratch(root);
  let reclaimer: tokens.SqliteStagingToken | undefined;
  // Schedule a real second SQLite connection in any released-lock interval,
  // as another backup process's maintenance can do between native statements.
  interpose = () => {
    reclaimer = tokens.acquireSqliteStagingToken(scratch.directory, "reclaim");
  };
  try {
    await fs.writeFile(path.join(scratch.directory, "config-0"), "owned payload");
    await expect(finishScratch(scratch, () => {})).resolves.toBeUndefined();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  } finally {
    interpose = () => {};
    reclaimer?.();
    scratch.release();
  }
});
