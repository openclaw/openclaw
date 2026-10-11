import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { root as openLockRoot, type Root } from "@openclaw/fs-safe/root";
import { sql } from "kysely";
import { z } from "zod";
import { formatCliCommand } from "../cli/command-format.js";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { acquireFileLockSyncWithRetry } from "./file-lock-sync.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  isSqliteLockError,
  sqliteErrorCode,
  sqliteExtendedResultCode,
} from "./sqlite-error-diagnostics.js";
import {
  createExistingSqliteRollbackReader,
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import { runWithSqliteCleanup } from "./sqlite-lifecycle-errors.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { databaseFileIdentityKey } from "./sqlite-worker-identity.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import { quarantineManagedHandoffStore } from "./update-managed-service-handoff-store-repair.js";
import { createPrivateWindowsFile } from "./windows-private-directory.js";

export type LeaseRow = { owner: string; payload_json: string; updated_at: number };
export type LeaseTable = LeaseRow & { install_root: string; recovery_json?: string | null };
export const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);

const HANDOFF_BUSY_TIMEOUT_MS = 5_000;
const writeAdmissions = new AsyncLocalStorage<{
  owner: string;
  deadline: number;
}>();

type HandoffDatabaseOwner = {
  <T>(write: boolean, operation: (db: HandoffDatabase) => T): T;
  forExisting(identity: ManagedUpdateLeaseDatabaseIdentity): HandoffDatabaseOwner;
  retainReadConnection(this: void): { [Symbol.dispose](): void };
  transact<T>(db: HandoffDatabase, operation: () => T, options: SqliteTransactionOptions): T;
};

function identityChangedMessage(databasePath: string, changes: string[]): string {
  return `managed handoff lease database identity changed at ${databasePath}: ${changes.join("; ")}. Run ${formatCliCommand("openclaw update repair")}.`;
}

function assertRecordedDatabasePath(
  databasePath: string,
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity,
): void {
  if (existingIdentity && databasePath !== existingIdentity.databasePath) {
    throw new Error(
      identityChangedMessage(databasePath, [
        `path (recorded ${existingIdentity.databasePath}; current ${databasePath})`,
      ]),
    );
  }
}

function prepareHandoffDirectory(databasePath: string): void {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("managed handoff lease directory is unsafe");
  }
  fs.chmodSync(dir, 0o700);
}

/** Prepare a directory capability without repairing identity-bound storage. */
export async function prepareManagedHandoffLeaseDatabase(
  databasePath: string,
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity,
) {
  assertRecordedDatabasePath(databasePath, existingIdentity);
  if (existingIdentity) {
    assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  } else {
    prepareHandoffDirectory(databasePath);
  }
  const lockRoot = await openLockRoot(path.dirname(databasePath));
  if (existingIdentity) {
    assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  }
  return createManagedHandoffLeaseDatabase(databasePath, existingIdentity, lockRoot);
}

/** Bootstrap owned storage and capture the identity used by later no-repair operations. */
export async function prepareManagedHandoffLeaseDatabaseIdentity(
  databasePath: string,
  assertCurrent?: () => void,
) {
  const withDatabase = await prepareManagedHandoffLeaseDatabase(databasePath);
  assertCurrent?.();
  return withDatabase(true, () => captureManagedUpdateLeaseDatabaseIdentity(databasePath));
}

const text = z.string().min(1).max(4096);
const repairMetadataSchema = z.strictObject({
  version: z.literal(3),
  binding: z.string(),
  source: z.strictObject({
    owner: text,
    payload_json: z.string(),
    updated_at: z.number().int().nonnegative(),
  }),
  facts: z.strictObject({
    runIds: z.array(text).min(1),
    artifactPaths: z.array(text.refine(path.isAbsolute)),
    timeoutMs: z.number().int().positive().safe().nullable(),
  }),
});
export type ManagedHandoffRepairFacts = z.infer<typeof repairMetadataSchema>["facts"];
export const managedHandoffLeaseBinding = (lease: ManagedHandoffLease) =>
  JSON.stringify([lease.owner, lease.payload, lease.updatedAt]);

const recoveryColumns = new WeakSet<HandoffDatabase>();

export function readManagedHandoffRepairMetadata(
  db: HandoffDatabase,
  lease: ManagedHandoffLease,
  transact: ExistingSqliteTransaction,
) {
  if (!recoveryColumns.has(db)) {
    if (db.isTransaction) {
      throw new Error("Handoff recovery schema requires a separate writer admission.");
    }
    // Commit first-use DDL before caching its admitted fact or reading metadata.
    transact(() => ensureColumn(db, "managed_update_handoffs", "recovery_json TEXT"));
    recoveryColumns.add(db);
  }
  const retained = executeSqliteQueryTakeFirstSync(
    db,
    leaseQueries(db)
      .selectFrom("managed_update_handoffs")
      .select("recovery_json")
      .where("install_root", "=", lease.key),
  )?.recovery_json;
  const parsed = retained ? safeParseJsonWithSchema(repairMetadataSchema, retained) : null;
  if (retained !== null && retained !== undefined && !parsed) {
    throw new Error("Handoff recovery metadata is unreadable; preserve its retained artifacts.");
  }
  return parsed?.binding === managedHandoffLeaseBinding(lease) ? parsed : null;
}

function initializeLeaseSchema(db: HandoffDatabase): void {
  executeSqliteQuerySync(
    db,
    leaseQueries(db)
      .schema.createTable("managed_update_handoffs")
      .ifNotExists()
      .addColumn("install_root", "text", (column) => column.notNull().primaryKey())
      .addColumn("owner", "text", (column) => column.notNull())
      .addColumn("payload_json", "text", (column) => column.notNull())
      .addColumn("updated_at", "integer", (column) => column.notNull())
      .addColumn("recovery_json", "text")
      .modifyEnd(sql`STRICT`),
  );
}

export type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";

export function assertManagedHandoffPath(stat: BigIntStats, kind: "directory" | "file") {
  if (
    stat.isSymbolicLink() ||
    !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
    (kind === "file" && stat.nlink !== 1n) ||
    (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error("managed handoff lease " + kind + " is unsafe");
  }
}

// Earlier writers chmodded after schema creation. Repair their excess read bits
// only inside the owned 0700 directory; write bits remain unsafe because chmod
// cannot revoke an existing descriptor. Ownership, type and link checks still apply.
function repairPrivateFileMode(databasePath: string, stat: BigIntStats): BigIntStats {
  if (
    process.platform === "win32" ||
    (stat.mode & 0o077n) === 0n ||
    (stat.mode & 0o022n) !== 0n ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()))
  ) {
    return stat;
  }
  fs.chmodSync(databasePath, 0o600);
  return fs.lstatSync(databasePath, { bigint: true });
}

export function assertSameManagedHandoffPath(
  stat: BigIntStats,
  expected: BigIntStats,
  kind: "directory" | "file",
): void {
  assertManagedHandoffPath(stat, kind);
  if (
    (process.platform === "win32" &&
      [stat.dev, stat.ino, expected.dev, expected.ino].includes(0n)) ||
    databaseFileIdentityKey(stat) !== databaseFileIdentityKey(expected)
  ) {
    throw new Error("managed handoff lease " + kind + " changed during initialization");
  }
}

type HandoffDirectoryReceipt = {
  path: string;
  realPath: string;
  identity: BigIntStats;
};

function createMissingDatabaseFile(
  databasePath: string,
  parentReceipt: HandoffDirectoryReceipt,
): void {
  let descriptor: number | undefined;
  try {
    descriptor =
      process.platform === "win32"
        ? createPrivateWindowsFile(databasePath)
        : fs.openSync(
            databasePath,
            fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_NOFOLLOW,
            0o600,
          );
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  }
  try {
    if (descriptor !== undefined) {
      fs.fchmodSync(descriptor, 0o600);
      // SQLite commits schema on this inode; a crash here leaves its existing empty-file recovery.
      fs.fsyncSync(descriptor);
    }
    // Windows file IDs can exceed Number's exact integer range.
    const identity =
      descriptor === undefined
        ? repairPrivateFileMode(databasePath, fs.lstatSync(databasePath, { bigint: true }))
        : fs.fstatSync(descriptor, { bigint: true });
    const currentIdentity = fs.lstatSync(databasePath, { bigint: true });
    assertSameManagedHandoffPath(currentIdentity, identity, "file");
    assertSameManagedHandoffPath(
      fs.lstatSync(parentReceipt.path, { bigint: true }),
      parentReceipt.identity,
      "directory",
    );
    const directorySync = syncDirectorySync(parentReceipt);
    requireDirectorySync(directorySync, "Managed handoff lease directory");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

// Excess read bits are repairable; writable or foreign files cannot be adopted.
function isUnadoptableStore(stat: Stats): boolean {
  return (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o022) !== 0)
  );
}

/** Capture only an already-admitted database, never provision one during recovery. */
export function captureManagedUpdateLeaseDatabaseIdentity(
  databasePath: string,
  previous?: ManagedUpdateLeaseDatabaseIdentity,
  legacyNumeric = false,
): ManagedUpdateLeaseDatabaseIdentity {
  let canonical: string;
  let file: BigIntStats | undefined;
  let parent: BigIntStats;
  try {
    canonical = fs.realpathSync(databasePath);
    file = fs.lstatSync(canonical, { bigint: true });
    parent = fs.lstatSync(path.dirname(canonical), { bigint: true });
  } catch (error) {
    if (previous && error instanceof Error && hasErrnoCode(error, "ENOENT")) {
      const part = file ? "parent directory" : "file";
      const recorded = file ? previous.parentIdentity : previous.databaseIdentity;
      // Keep the original filesystem error and code for missing-store recovery callers.
      error.message = `${identityChangedMessage(databasePath, [
        `${part} identity (recorded ${recorded}; current missing)`,
      ])} ${error.message}`;
    }
    throw error;
  }
  assertManagedHandoffPath(file, "file");
  assertManagedHandoffPath(parent, "directory");
  // Accepted <=9.6 one-hop tradeoff: Number serialization can hide an inode collision.
  // Admit its shipped spelling once, then pin bigint identities for every later check.
  const matches = (stat: BigIntStats, expected: string) =>
    expected === databaseFileIdentityKey(stat) ||
    (legacyNumeric && expected === `${Number(stat.dev)}:${Number(stat.ino)}`);
  if (previous) {
    const changes: string[] = [];
    if (canonical !== previous.databasePath) {
      changes.push(`path (recorded ${previous.databasePath}; current ${canonical})`);
    }
    if (!matches(file, previous.databaseIdentity)) {
      changes.push(
        `file identity (recorded ${previous.databaseIdentity}; current ${databaseFileIdentityKey(file)})`,
      );
    }
    if (!matches(parent, previous.parentIdentity)) {
      changes.push(
        `parent directory identity (recorded ${previous.parentIdentity}; current ${databaseFileIdentityKey(parent)})`,
      );
    }
    if (changes.length) {
      throw new Error(identityChangedMessage(databasePath, changes));
    }
  }
  return Object.freeze({
    databasePath: canonical,
    databaseIdentity: databaseFileIdentityKey(file),
    parentIdentity: databaseFileIdentityKey(parent),
  });
}

export function assertManagedUpdateLeaseDatabaseIdentity(
  binding: ManagedUpdateLeaseDatabaseIdentity,
): void {
  captureManagedUpdateLeaseDatabaseIdentity(binding.databasePath, binding);
}

/** Existing managed-update lease storage; extraction does not change its schema. */
export function createManagedHandoffLeaseDatabase(
  databasePath: string,
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity,
  writeLockRoot?: Root,
): HandoffDatabaseOwner {
  assertRecordedDatabasePath(databasePath, existingIdentity);
  const assertCurrent = () => {
    if (existingIdentity) {
      assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
    }
  };
  const existingTransactions = new WeakMap<HandoffDatabase, ExistingSqliteTransaction>();
  const existingOptions = existingIdentity
    ? {
        busyTimeoutMs: HANDOFF_BUSY_TIMEOUT_MS,
        assertIdentity: assertCurrent,
      }
    : undefined;
  let readExisting: ReturnType<typeof createExistingSqliteRollbackReader> | undefined;
  /**
   * The store keeps its directory at 0700, so drift on a directory we own is its
   * own interrupted work. Ownership and type stay the temp-root resolver's call.
   */
  function recoverDirectoryMode(target: string): void {
    if (process.platform === "win32") {
      return;
    }
    try {
      const stat = fs.lstatSync(target);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) !== 0 &&
        (typeof process.getuid !== "function" || stat.uid === process.getuid())
      ) {
        fs.chmodSync(target, 0o700);
      }
    } catch {
      // A missing or unreadable directory is the resolver's to answer, not ours.
    }
  }

  // Recheck under the lock: quarantining a store another repairer just replaced
  // would leave two authoritative databases and defeat cross-install coordination.
  function recoverUnadoptableStore(target: string, parent: HandoffDirectoryReceipt): void {
    if (!observeUnadoptable(target)) {
      return;
    }
    const release = acquireFileLockSyncWithRetry(
      target,
      writeLockRoot
        ? {
            lockRoot: writeLockRoot,
            reentrantOwner: writeAdmissions.getStore()?.owner,
            timeoutMs: HANDOFF_BUSY_TIMEOUT_MS,
          }
        : undefined,
    );
    try {
      if (!observeUnadoptable(target)) {
        return;
      }
      quarantineManagedHandoffStore(target, "unsafe-file");
      // Readers open read-only and cannot create a store, so removing the blocker
      // without replacing it would move the dead end rather than clear it.
      createMissingDatabaseFile(target, parent);
    } finally {
      release();
    }
  }

  function observeUnadoptable(target: string): boolean {
    try {
      return isUnadoptableStore(fs.lstatSync(target));
    } catch {
      return false;
    }
  }

  function accessDatabase<T>(
    write: boolean,
    operation: (db: HandoffDatabase) => T,
    busyTimeoutMs = HANDOFF_BUSY_TIMEOUT_MS,
  ): T {
    if (existingOptions) {
      const run = (db: HandoffDatabase, transact: ExistingSqliteTransaction) => {
        existingTransactions.set(db, transact);
        try {
          return operation(db);
        } finally {
          existingTransactions.delete(db);
        }
      };
      return !write && readExisting
        ? readExisting(run)
        : withExistingSqliteRollbackDatabase(
            databasePath,
            { ...existingOptions, busyTimeoutMs, write },
            run,
          );
    }
    const dir = path.dirname(databasePath);
    if (write) {
      prepareHandoffDirectory(databasePath);
    }
    recoverDirectoryMode(dir);
    const directoryIdentity = fs.lstatSync(dir, { bigint: true });
    assertManagedHandoffPath(directoryIdentity, "directory");
    // syncDirectorySync verifies ordinary realpath spelling. Windows native
    // realpath can expand an 8.3 alias differently without changing the directory.
    recoverUnadoptableStore(databasePath, {
      path: dir,
      realPath: fs.realpathSync(dir),
      identity: directoryIdentity,
    });
    if (write && !fs.existsSync(databasePath)) {
      createMissingDatabaseFile(databasePath, {
        path: dir,
        realPath: fs.realpathSync(dir),
        identity: directoryIdentity,
      });
    }
    const databaseIdentity = repairPrivateFileMode(
      databasePath,
      fs.lstatSync(databasePath, { bigint: true }),
    );
    assertManagedHandoffPath(databaseIdentity, "file");
    const db = openNodeSqliteDatabase(
      write ? resolveExistingSqliteFileUri(databasePath) : databasePath,
      { readOnly: !write },
    );
    try {
      assertSameManagedHandoffPath(
        fs.lstatSync(dir, { bigint: true }),
        directoryIdentity,
        "directory",
      );
      assertSameManagedHandoffPath(
        fs.lstatSync(databasePath, { bigint: true }),
        databaseIdentity,
        "file",
      );
      setSqliteBusyTimeout(db, busyTimeoutMs);
      if (write) {
        initializeLeaseSchema(db);
      }
      return operation(db);
    } finally {
      // Canonical rollback may already close a damaged handle; keep its original error.
      if (db.isOpen) {
        db.close();
      }
    }
  }
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
    if (!write || !writeLockRoot) {
      return accessDatabase(write, operation);
    }
    assertCurrent();
    const admission = writeAdmissions.getStore() ?? {
      owner: randomUUID(),
      deadline: performance.now() + HANDOFF_BUSY_TIMEOUT_MS,
    };
    const remaining = () => Math.max(0, Math.ceil(admission.deadline - performance.now()));
    // Wait before pinning a SHARED snapshot, which would block the current writer's commit.
    const release = acquireFileLockSyncWithRetry(databasePath, {
      lockRoot: writeLockRoot,
      reentrantOwner: admission.owner,
      timeoutMs: remaining(),
    });
    return runWithSqliteCleanup({ release }, "Managed handoff writer admission", () =>
      writeAdmissions.run(admission, () => accessDatabase(write, operation, remaining())),
    );
  }
  return Object.assign(withDatabase, {
    forExisting(identity: ManagedUpdateLeaseDatabaseIdentity) {
      return createManagedHandoffLeaseDatabase(identity.databasePath, identity, writeLockRoot);
    },
    retainReadConnection(this: void) {
      if (!existingOptions || readExisting) {
        throw new Error("Existing SQLite reader requires an unretained identity-bound store.");
      }
      const reader = createExistingSqliteRollbackReader(databasePath, existingOptions);
      readExisting = reader;
      return {
        [Symbol.dispose]() {
          if (readExisting === reader) {
            readExisting = undefined;
          }
          reader[Symbol.dispose]();
        },
      };
    },
    transact<T>(db: HandoffDatabase, operation: () => T, options: SqliteTransactionOptions): T {
      const transact: ExistingSqliteTransaction =
        existingTransactions.get(db) ??
        ((write, transactionOptions) =>
          runSqliteImmediateTransactionSync(db, write, transactionOptions));
      let entered = false;
      try {
        return transact(
          () => {
            entered = true;
            return operation();
          },
          {
            ...options,
            withCommit: (commit) => {
              assertCurrent();
              commit();
            },
          },
        );
      } catch (error) {
        // Older writers do not take the prepared owner's mutex. Never relabel admitted SQL or commit failures.
        if (writeLockRoot && !entered && isSqliteLockError(error)) {
          throw Object.assign(
            new Error(
              "The managed handoff database is locked. Another OpenClaw update or Doctor from an older release may still be using it. Wait for it to finish, then rerun this command.",
              { cause: error },
            ),
            { code: sqliteErrorCode(error), errcode: sqliteExtendedResultCode(error) },
          );
        }
        throw error;
      }
    },
  });
}
