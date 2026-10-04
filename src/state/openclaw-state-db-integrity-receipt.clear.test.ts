import { copyFileSync, closeSync, openSync, realpathSync, writeSync } from "node:fs";
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
    // Receipts are process-wide and this vitest worker is shared with other test files: free this
    // file's slots instead of leaking proofs into them. Retained descriptors are never released,
    // so a clear hands back slots only, never the descriptor budget.
    clearOpenClawStateIntegrityReceipts();
    cleanup();
  }),
);

function createStateDatabase(prefix: string): string {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix) };
  const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

// Receipts name the file the handle owner bound at open time, so admission in a test has to come
// through that owner exactly as production admission does.
function fastPath(pathname: string): boolean {
  const database = openTrackedStateDatabase(pathname, { readOnly: true });
  try {
    return isOpenClawStateSchemaFastPathEligible(database, pathname);
  } finally {
    closeTrackedStateDatabase(database);
  }
}

describe("shared-state integrity receipt fail-closed", () => {
  it("forgets the proof of every other unchanged file after any failed check", () => {
    const first = createStateDatabase("state-integrity-receipt-clear-a-");
    const second = createStateDatabase("state-integrity-receipt-clear-b-");
    const corrupted = first + ".corrupted";
    copyFileSync(first, corrupted);
    const pageSize = (() => {
      const db = new DatabaseSync(first, { readOnly: true });
      try {
        return (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      } finally {
        db.close();
      }
    })();
    const fd = openSync(corrupted, "r+");
    try {
      writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, pageSize);
    } finally {
      closeSync(fd);
    }
    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
    const prepare = DatabaseSync.prototype.prepare;
    let checks = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (/^PRAGMA integrity_check;?$/u.test(sql)) {
        checks += 1;
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    fastPath(first);
    fastPath(second);
    expect(checks).toBe(2);
    // Positive control: both receipts are honoured by a fresh connection. Without this, a harness
    // that never minted anything would pass the re-proof count below just as well.
    fastPath(first);
    fastPath(second);
    expect(checks).toBe(2);

    expect(() => fastPath(corrupted)).toThrow(/integrity_check|malformed|corrupt/iu);
    // Neither file was replaced or touched: only the fail-closed clear can force these re-proofs.
    fastPath(first);
    fastPath(second);
    expect(checks).toBe(5);
  });

  it("does not let a check that was running when another check failed mint a receipt", () => {
    const pathname = createStateDatabase("state-integrity-receipt-clear-race-");
    const corrupted = pathname + ".corrupted";
    copyFileSync(pathname, corrupted);
    const pageSize = (() => {
      const db = new DatabaseSync(pathname, { readOnly: true });
      try {
        return (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      } finally {
        db.close();
      }
    })();
    const fd = openSync(corrupted, "r+");
    try {
      writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, pageSize);
    } finally {
      closeSync(fd);
    }

    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
    const prepare = DatabaseSync.prototype.prepare;
    let checks = 0;
    let interleaved = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (/^PRAGMA integrity_check;?$/u.test(sql)) {
        checks += 1;
        if (!interleaved && this.location() === pathname) {
          interleaved = true;
          // Stands in for another thread: its check fails, and clears receipts, while this proof runs.
          expect(() => fastPath(corrupted)).toThrow(/integrity_check|malformed|corrupt/iu);
        }
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    const checksPerAdmission = [0, 1, 2].map(() => {
      const before = checks;
      expect(fastPath(pathname)).toBe(true);
      return checks - before;
    });
    // First: its own check plus the failing one. Second: that proof straddled a clear, so it was not
    // trusted and the file is proved again. Third: the clean proof is reused.
    expect(checksPerAdmission).toEqual([2, 1, 0]);
  });
});
