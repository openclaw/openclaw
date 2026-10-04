import { existsSync, fstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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

const PROC_FD_DIRECTORY = "/proc/self/fd";

/**
 * How many descriptors this process holds on one dev:ino pair. Reading /proc is what makes the
 * security property observable instead of inferred: a retained descriptor, not the filesystem's
 * inode allocator, is what keeps a proved inode from being handed to a different file.
 */
function descriptorsOnIdentity(identity: string): number {
  let found = 0;
  for (const entry of readdirSync(PROC_FD_DIRECTORY)) {
    try {
      const file = fstatSync(Number(entry), { bigint: true });
      if (`${file.dev}:${file.ino}` === identity) {
        found += 1;
      }
    } catch {
      // A descriptor can vanish between the directory read and the fstat; it is not a proved one.
    }
  }
  return found;
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

  it("scans a physically new file created at a proved path and keeps the proved inode held", () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-integrity-receipt-inode-new-file-") };
    const createAtSamePath = (): string => {
      const created = realpathSync(openOpenClawStateDatabase({ env }).path);
      closeOpenClawStateDatabaseForTest();
      return created;
    };
    const removeAtSamePath = (target: string): void => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(target + suffix, { force: true });
      }
    };
    const checks = countFullIntegrityChecks();
    const admit = (target: string): number => {
      const before = checks.count;
      const database = openTrackedStateDatabase(target, { readOnly: true });
      try {
        expect(isOpenClawStateSchemaFastPathEligible(database, target)).toBe(true);
      } finally {
        closeTrackedStateDatabase(database);
      }
      return checks.count - before;
    };

    const pathname = createAtSamePath();
    const provedIdentity = fileIdentity(pathname);
    expect(admit(pathname)).toBe(1);
    // Positive control: the proof is a live, reusable receipt, so the full scan asserted below
    // means the new file was refused the receipt rather than that no receipt existed.
    expect(admit(pathname)).toBe(0);

    removeAtSamePath(pathname);
    const replacement = createAtSamePath();
    expect(replacement).toBe(pathname);
    if (existsSync(PROC_FD_DIRECTORY)) {
      // The mechanism itself: the proof owner still holds the proved inode open, which is why the
      // filesystem could not hand that identity to this new file.
      expect(descriptorsOnIdentity(provedIdentity)).toBeGreaterThan(0);
    }
    expect(fileIdentity(pathname)).not.toBe(provedIdentity);
    // The security property: a different physical file at the proved path runs the whole check.
    expect(admit(pathname)).toBe(1);
    removeAtSamePath(pathname);
  });
});
