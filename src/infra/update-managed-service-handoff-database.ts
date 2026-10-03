import fs, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { z } from "zod";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { acquireFileLockSyncWithRetry } from "./file-lock-sync.js";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  createExistingSqliteRollbackReader,
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { databaseFileIdentityKey } from "./sqlite-worker-identity.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";
import { quarantineManagedHandoffStore } from "./update-managed-service-handoff-store-repair.js";
import { createPrivateWindowsFile } from "./windows-private-directory.js";

export type LeaseRow = { owner: string; payload_json: string; updated_at: number };
export type LeaseTable = LeaseRow & { install_root: string; recovery_json?: string | null };
export const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);

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

function assertPath(stat: BigIntStats, kind: "directory" | "file") {
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

/**
 * Earlier writers created the file under the caller's umask and chmodded it
 * after schema creation. Excess read bits on a path we own can therefore be
 * that interrupted work. Restore the
 * invariant instead of refusing, which would otherwise lock the product out of its
 * own state for every install root until an operator deleted the file by hand.
 *
 * Excess bits here are defense in depth rather than a live exposure: assertPath
 * enforces a 0700 owned directory on every read and every write, and a single
 * link, so no other user could traverse to this inode or hold a descriptor on it
 * whatever the file's own mode said. Write bits are still refused rather than
 * repaired, because chmod cannot revoke a descriptor and integrity is the one
 * thing the directory guarantee would not restore. Ownership, type and link count
 * are likewise not ours to repair; all of those still refuse in assertPath.
 */
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

function assertSamePath(
  stat: BigIntStats,
  expected: BigIntStats,
  kind: "directory" | "file",
): void {
  assertPath(stat, kind);
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
    assertSamePath(currentIdentity, identity, "file");
    assertSamePath(
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

/**
 * Bytes we could never adopt: the path is not our regular single-linked file, or
 * it carries write bits, which mean a descriptor we cannot revoke may already
 * exist. Excess read bits are excluded — repairPrivateFileMode restores those in
 * place, because the store sets 0600 after every write and keeps its directory
 * private, so they are its own interrupted work.
 */
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
  const canonical = fs.realpathSync(databasePath);
  const file = fs.lstatSync(canonical, { bigint: true });
  const parent = fs.lstatSync(path.dirname(canonical), { bigint: true });
  assertPath(file, "file");
  assertPath(parent, "directory");
  // Accepted <=9.6 one-hop tradeoff: Number serialization can hide an inode collision.
  // Admit its shipped spelling once, then pin bigint identities for every later check.
  const matches = (stat: BigIntStats, expected: string) =>
    expected === databaseFileIdentityKey(stat) ||
    (legacyNumeric && expected === `${Number(stat.dev)}:${Number(stat.ino)}`);
  if (
    previous &&
    (canonical !== previous.databasePath ||
      !matches(file, previous.databaseIdentity) ||
      !matches(parent, previous.parentIdentity))
  ) {
    throw new Error("managed handoff lease database identity changed");
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

/** Explicit cold repair of one installation's executor journal; normal readers never replay it. */
export async function recoverManagedUpdateLeaseJournal(params: {
  existingIdentity: ManagedUpdateLeaseDatabaseIdentity;
  installKey: string;
  serviceManagerEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  const { existingIdentity, installKey } = params;
  if (path.resolve(installKey) !== installKey || installKey.includes("/.openclaw-update-child-")) {
    throw new Error("Managed update journal recovery requires its original installation key.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  const [{ acquireFileLock }, { prepareSqliteRollbackRecovery }] = await Promise.all([
    import("./file-lock.js"),
    import("./sqlite-rollback-recovery.js"),
  ]);
  assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  const lock = await acquireFileLock(existingIdentity.databasePath, {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 30_000,
    staleRecovery: "remove-if-definitely-stale",
  });
  let active = true;
  try {
    const lockIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
    assertPath(lockIdentity, "file");
    const lockBytes = fs.readFileSync(lock.lockPath);
    const assertBootstrap = () => {
      if (!active) {
        throw new Error("Managed update journal bootstrap authority has closed.");
      }
      assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
      assertSamePath(fs.lstatSync(lock.lockPath, { bigint: true }), lockIdentity, "file");
      if (!fs.readFileSync(lock.lockPath).equals(lockBytes)) {
        throw new Error("Managed update journal bootstrap lock changed.");
      }
    };
    assertBootstrap();
    const { processState } = createManagedHandoffProcessIdentityReader({
      env: params.serviceManagerEnv,
    });
    const assertDeadOwner = (rows: LeaseTable[]) => {
      if (!rows.length) {
        return;
      }
      const row = rows[0]!;
      const payload = parseManagedHandoffLeasePayload(row.payload_json);
      if (
        rows.length !== 1 ||
        row.install_root !== installKey ||
        !text.safeParse(row.owner).success ||
        !Number.isSafeInteger(row.updated_at) ||
        row.updated_at < 0 ||
        row.recovery_json !== null ||
        !payload ||
        payload.version !== 2 ||
        payload.mutationOriginal ||
        payload.action.kind !== "update" ||
        payload.action.mutationProtocol !== "original-cancellation-v1" ||
        payload.action.custody !== undefined ||
        !isDeepStrictEqual(payload.helper, payload.executor)
      ) {
        throw new Error(
          "Managed update journal recovery refuses foreign or retained executor custody.",
        );
      }
      if (processState(payload.helper) !== "dead" || processState(payload.executor) !== "dead") {
        throw new Error(
          "Managed update journal recovery requires a definitely dead original executor.",
        );
      }
    };
    const read = (db: HandoffDatabase): LeaseTable[] => {
      // Recovery admission accepts exactly the current dedicated lease schema,
      // never a future writer, trigger, mirror table or unknown retained payload.
      const objects = db // sqlite-allow-raw -- Explicit cold-recovery schema admission before any source journal replay.
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name <> 'sqlite_autoindex_managed_update_handoffs_1'",
        )
        .all();
      const table = db // sqlite-allow-raw -- Native STRICT-table facts belong to one recovery admission.
        .prepare("PRAGMA table_list('managed_update_handoffs')")
        .all()
        .find((entry) => entry.schema === "main");
      const columns = db // sqlite-allow-raw -- Validate the exact lease schema; recovery performs no migration.
        .prepare("PRAGMA table_info('managed_update_handoffs')")
        .all();
      const expectedColumns = [
        ["install_root", "TEXT", 1, 1],
        ["owner", "TEXT", 1, 0],
        ["payload_json", "TEXT", 1, 0],
        ["updated_at", "INTEGER", 1, 0],
        ["recovery_json", "TEXT", 0, 0],
      ];
      if (
        objects.length !== 1 ||
        objects[0]?.type !== "table" ||
        objects[0]?.name !== "managed_update_handoffs" ||
        table?.type !== "table" ||
        table.strict !== 1 ||
        table.wr !== 0 ||
        table.ncol !== 5 ||
        columns.length !== expectedColumns.length ||
        columns.some((column, index) => {
          const expected = expectedColumns[index]!;
          return (
            column.name !== expected[0] ||
            column.type !== expected[1] ||
            column.notnull !== expected[2] ||
            column.pk !== expected[3] ||
            column.dflt_value !== null
          );
        })
      ) {
        throw new Error("Managed update journal recovery refuses an unknown lease schema.");
      }
      const sizes = executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select((eb) => [
            eb.fn<number>("length", [eb.cast("payload_json", "blob")]).as("payloadBytes"),
            eb.fn<number>("length", [eb.cast("owner", "blob")]).as("ownerBytes"),
            eb.fn<number>("length", [eb.cast("install_root", "blob")]).as("keyBytes"),
            eb.fn<number | null>("length", [eb.cast("recovery_json", "blob")]).as("recoveryBytes"),
          ])
          .limit(2),
      ).rows;
      if (
        sizes.length > 1 ||
        sizes.some(
          (size) =>
            size.payloadBytes > 16_384 ||
            size.ownerBytes > 4096 ||
            size.keyBytes > 4096 ||
            size.recoveryBytes !== null,
        )
      ) {
        throw new Error(
          "Managed update journal recovery refuses foreign or retained executor custody.",
        );
      }
      const rows = executeSqliteQuerySync(
        db,
        leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().limit(2),
      ).rows;
      assertDeadOwner(rows);
      return rows;
    };
    const recovery = await prepareSqliteRollbackRecovery({
      path: existingIdentity.databasePath,
      scratchRoot: path.dirname(existingIdentity.databasePath),
      assertIdentity: assertBootstrap,
      assertFileSafe: (_file, stat) => assertPath(stat, "file"),
      read,
    });
    recovery.admit(() => {
      assertBootstrap();
      assertDeadOwner(recovery.record);
    });
  } finally {
    active = false;
    await lock.release();
  }
}

/** Existing managed-update lease storage; extraction does not change its schema. */
export function createManagedHandoffLeaseDatabase(
  databasePath: string,
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity,
) {
  if (existingIdentity && databasePath !== existingIdentity.databasePath) {
    throw new Error("managed handoff lease database path changed");
  }
  const existingTransactions = new WeakMap<HandoffDatabase, ExistingSqliteTransaction>();
  const validationQuery = createSqliteQueryCache((db) =>
    prepareSqliteQuerySync<void, LeaseTable>(db, () =>
      leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().limit(0),
    ),
  );
  const existingOptions = existingIdentity
    ? {
        busyTimeoutMs: 5000,
        assertIdentity: () => assertManagedUpdateLeaseDatabaseIdentity(existingIdentity),
        validate: (db: HandoffDatabase) => {
          validationQuery(db)();
        },
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

  /**
   * Coordination state lives in a shared temp directory, so a store we cannot
   * adopt used to end config mutation and native service operations for every
   * install root on the host, permanently and with no in-product recovery.
   * Retain it under a name recording the defect and leave a usable store behind.
   *
   * Repairers must not race: renaming on a stale observation lets one process
   * retain the clean store another already opened, leaving two authoritative
   * databases and defeating the lock this store exists to provide. The decision
   * is therefore retaken under the lock, where the replacement is visible.
   */
  function recoverUnadoptableStore(target: string, parent: HandoffDirectoryReceipt): void {
    if (!observeUnadoptable(target)) {
      return;
    }
    const release = acquireFileLockSyncWithRetry(target);
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

  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
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
        : withExistingSqliteRollbackDatabase(databasePath, { ...existingOptions, write }, run);
    }
    const dir = path.dirname(databasePath);
    if (write) {
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
    recoverDirectoryMode(dir);
    const directoryIdentity = fs.lstatSync(dir, { bigint: true });
    assertPath(directoryIdentity, "directory");
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
    assertPath(databaseIdentity, "file");
    const db = openNodeSqliteDatabase(
      write ? resolveExistingSqliteFileUri(databasePath) : databasePath,
      { readOnly: !write },
    );
    try {
      assertSamePath(fs.lstatSync(dir, { bigint: true }), directoryIdentity, "directory");
      assertSamePath(fs.lstatSync(databasePath, { bigint: true }), databaseIdentity, "file");
      setSqliteBusyTimeout(db, 5000);
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
  return Object.assign(withDatabase, {
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
      const assertCurrent = () => {
        if (existingIdentity) {
          assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
        }
      };
      assertCurrent();
      const transact: ExistingSqliteTransaction =
        existingTransactions.get(db) ??
        ((write, transactionOptions) =>
          runSqliteImmediateTransactionSync(db, write, transactionOptions));
      return transact(
        () => {
          assertCurrent();
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
    },
  });
}
