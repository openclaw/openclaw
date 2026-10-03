import { copyFileSync, closeSync, openSync, realpathSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isOpenClawStateSchemaFastPathEligible } from "./openclaw-state-db-fast-path.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createStateDatabase(prefix: string): string {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix) };
  const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

function fastPath(pathname: string): boolean {
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    return isOpenClawStateSchemaFastPathEligible(database, pathname);
  } finally {
    database.close();
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
    fastPath(first);
    fastPath(second);

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
    expect(() => fastPath(corrupted)).toThrow(/integrity_check|malformed|corrupt/iu);
    // Neither file was replaced or touched: only the fail-closed clear can force these re-proofs.
    fastPath(first);
    fastPath(second);
    expect(checks).toBe(3);
  });
});
