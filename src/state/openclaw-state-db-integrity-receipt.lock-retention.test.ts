import { spawnSync } from "node:child_process";
import { realpathSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isOpenClawStateSchemaFastPathEligible } from "./openclaw-state-db-fast-path.js";
import { closeTrackedStateDatabase, openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { clearOpenClawStateIntegrityReceipts } from "./openclaw-state-db-integrity-receipt.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    // Receipts are process-wide; free this file's slots. The descriptors this module retained are
    // deliberately never released, which is what the assertions below are about.
    clearOpenClawStateIntegrityReceipts();
    cleanup();
  }),
);

/**
 * Rollback-journal mode puts the transaction locks on the main database file, which is the file the
 * receipt owner retains a descriptor on. In WAL mode the write lock lives on the -shm file instead,
 * where this loss would not be observable at all.
 */
function createRollbackJournalStateDatabase(prefix: string): string {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix) };
  const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
  closeOpenClawStateDatabaseForTest();
  const database = new DatabaseSync(pathname);
  try {
    database.exec("PRAGMA journal_mode=delete");
  } finally {
    database.close();
  }
  return pathname;
}

const WRITE_LOCK_PROBE = [
  'const { DatabaseSync } = require("node:sqlite");',
  "let db;",
  "try {",
  "  db = new DatabaseSync(process.argv[1], { timeout: 0 });",
  "} catch (error) {",
  '  console.log("unopenable:" + error.message);',
  "  process.exit(0);",
  "}",
  "try {",
  '  db.exec("BEGIN IMMEDIATE");',
  '  db.exec("ROLLBACK");',
  '  console.log("acquired");',
  "} catch {",
  '  console.log("refused");',
  "}",
].join("\n");

/**
 * Another OS process is the only observer that can tell a surviving POSIX lock from a lost one.
 * Inside one process SQLite mediates locks through its own per-inode table, so a same-process probe
 * still reports contention after the kernel-level fcntl lock has been cancelled.
 */
function probeWriteLockFromAnotherProcess(pathname: string): string {
  const result = spawnSync(process.execPath, ["--no-warnings", "-e", WRITE_LOCK_PROBE, pathname], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      "write-lock probe failed: status=" + String(result.status) + " stderr=" + result.stderr,
    );
  }
  return result.stdout.trim();
}

describe("shared-state integrity receipts never close a descriptor on a database file", () => {
  it("keeps this process's write lock when a fail-closed clear forgets every receipt", () => {
    const pathname = createRollbackJournalStateDatabase("state-integrity-receipt-lock-clear-");
    const admitted = openTrackedStateDatabase(pathname, { readOnly: true });
    try {
      expect(isOpenClawStateSchemaFastPathEligible(admitted, pathname)).toBe(true);
    } finally {
      closeTrackedStateDatabase(admitted);
    }

    const holder = new DatabaseSync(pathname, { timeout: 0 });
    try {
      holder.exec("BEGIN EXCLUSIVE");
      // Positive control: the probe really can see a live lock, so "refused" below is not vacuous.
      expect(probeWriteLockFromAnotherProcess(pathname)).toBe("refused");

      clearOpenClawStateIntegrityReceipts();

      // Closing the descriptor retained by the receipt would cancel every fcntl lock this process
      // holds on the inode, and the probe would take the write lock out from under the holder.
      expect(probeWriteLockFromAnotherProcess(pathname)).toBe("refused");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("keeps the write lock on a replacement file whose pin attempt is refused", () => {
    const provedPath = createRollbackJournalStateDatabase("state-integrity-receipt-lock-mismatch-");
    const replacementPath = createRollbackJournalStateDatabase(
      "state-integrity-receipt-lock-mismatch-other-",
    );
    const opened = openTrackedStateDatabase(provedPath, { readOnly: true });
    const holder = new DatabaseSync(replacementPath, { timeout: 0 });
    try {
      holder.exec("BEGIN EXCLUSIVE");
      // The locked file takes over the proved path while the admitted connection still holds the
      // original inode, so the publication attempt opens this file and has to refuse it.
      renameSync(replacementPath, provedPath);
      // Positive control: the lock on the replacement is observable before the refusal runs.
      expect(probeWriteLockFromAnotherProcess(provedPath)).toBe("refused");

      expect(isOpenClawStateSchemaFastPathEligible(opened, provedPath)).toBe(true);

      expect(probeWriteLockFromAnotherProcess(provedPath)).toBe("refused");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      closeTrackedStateDatabase(opened);
    }
  });
});
