import { realpathSync, rmSync, statSync } from "node:fs";
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
    // The receipt table and its descriptor pins are process-wide and this file deliberately fills
    // several slots, so hand the capacity back to whatever test file shares this worker.
    clearOpenClawStateIntegrityReceipts();
    cleanup();
  }),
);

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

function fileIdentity(pathname: string): string {
  const file = statSync(pathname, { bigint: true });
  return `${file.dev}:${file.ino}`;
}

// Enough proved files to give the filesystem a wide target, kept well inside the receipt table so
// this file never starves a test file that shares its worker.
const ADMISSIONS = 8;
// Recreate-at-the-same-path attempts used to hunt for a reused inode.
const PROBE_ATTEMPTS = 60;

describe("shared-state integrity receipt and reused inodes", () => {
  it("never honours a proof for a different physical file that lands on a proved inode", () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-integrity-receipt-inode-reuse-") };
    const createAtSamePath = (): string => {
      const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
      closeOpenClawStateDatabaseForTest();
      return pathname;
    };
    const removeAtSamePath = (pathname: string): void => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(pathname + suffix, { force: true });
      }
    };

    const checks = countFullIntegrityChecks();
    const admit = (pathname: string): number => {
      const before = checks.count;
      const database = openTrackedStateDatabase(pathname, { readOnly: true });
      try {
        expect(isOpenClawStateSchemaFastPathEligible(database, pathname)).toBe(true);
      } finally {
        closeTrackedStateDatabase(database);
      }
      return checks.count - before;
    };

    // A run of physically different state databases, each created at the very same path with the
    // same schema cookie, and each admitted. Every one of them is a file this process has never
    // proved, so every admission must run the whole-file check.
    const ranPerAdmission: number[] = [];
    const proved = new Set<string>();
    let pathname = createAtSamePath();
    for (let admission = 0; admission < ADMISSIONS; admission += 1) {
      proved.add(fileIdentity(pathname));
      ranPerAdmission.push(admit(pathname));
      removeAtSamePath(pathname);
      pathname = createAtSamePath();
    }

    // While those proofs are live, the proof owner holds every proved file open, so the filesystem
    // cannot hand a freshly created file one of the proved dev:ino pairs. Without that binding the
    // identity is recyclable -- Linux reports no usable creation time here, so a recreated file at
    // the same path with the same schema would satisfy a receipt it never earned.
    const recycledProvedIdentities: string[] = [];
    for (let probe = 0; probe < PROBE_ATTEMPTS; probe += 1) {
      const identity = fileIdentity(pathname);
      if (proved.has(identity)) {
        recycledProvedIdentities.push(identity);
        break;
      }
      removeAtSamePath(pathname);
      pathname = createAtSamePath();
    }
    removeAtSamePath(pathname);

    expect({ ranPerAdmission, recycledProvedIdentities }).toEqual({
      ranPerAdmission: Array.from({ length: ADMISSIONS }, () => 1),
      recycledProvedIdentities: [],
    });
  });
});
