import { realpathSync, renameSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isOpenClawStateSchemaFastPathEligible } from "./openclaw-state-db-fast-path.js";
import {
  closeTrackedStateDatabase,
  openTrackedStateDatabase,
} from "./openclaw-state-db-handle.js";
import { clearOpenClawStateIntegrityReceipts } from "./openclaw-state-db-integrity-receipt.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    // Receipts and their descriptor pins are process-wide; release this file's share of the table.
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

function countFullIntegrityChecks(): { readonly count: number } {
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
  const prepare = DatabaseSync.prototype.prepare;
  const counter = { count: 0 };
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (/^PRAGMA integrity_check;?$/u.test(sql)) {
      counter.count += 1;
    }
    return Reflect.apply(prepare, this, [sql]);
  });
  return counter;
}

function withTrackedConnection<T>(pathname: string, run: (database: DatabaseSync) => T): T {
  const database = openTrackedStateDatabase(pathname, { readOnly: true });
  try {
    return run(database);
  } finally {
    closeTrackedStateDatabase(database);
  }
}

function fileIdentity(pathname: string): string {
  const file = statSync(pathname, { bigint: true });
  return `${file.dev}:${file.ino}`;
}

describe("shared-state integrity receipt names the file the connection opened", () => {
  it("never lets a file renamed over the path inherit the proof of the opened file", () => {
    const pathname = createStateDatabase("state-integrity-receipt-rename-over-");
    const replacement = createStateDatabase("state-integrity-receipt-rename-over-other-");
    const opened = openTrackedStateDatabase(pathname, { readOnly: true });
    try {
      const openedIdentity = fileIdentity(pathname);
      // A different, perfectly valid state database takes over the path while the connection that
      // is about to be proved still has the original inode open.
      renameSync(replacement, pathname);
      const renamedIdentity = fileIdentity(pathname);
      expect(renamedIdentity).not.toBe(openedIdentity);

      const checks = countFullIntegrityChecks();
      // This admission proves the file the connection actually holds, not the one now at the path.
      expect(isOpenClawStateSchemaFastPathEligible(opened, pathname)).toBe(true);
      const afterOpenedProof = checks.count;
      expect(afterOpenedProof).toBe(1);

      // The file now at the path has never been proved, so a fresh connection must scan it.
      expect(
        withTrackedConnection(pathname, (database) =>
          isOpenClawStateSchemaFastPathEligible(database, pathname),
        ),
      ).toBe(true);
      expect(checks.count - afterOpenedProof).toBe(1);
    } finally {
      closeTrackedStateDatabase(opened);
    }
  });
});
