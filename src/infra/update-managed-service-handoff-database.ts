import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { sql } from "kysely";
import {
  requireDirectorySync,
  syncDirectorySync,
  type DirectoryReceipt,
} from "./directory-durability.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "./sqlite-transaction.js";
import { createPrivateWindowsDirectory } from "./windows-private-directory.js";

export type LeaseRow = { owner: string; payload_json: string; updated_at: number };
export type LeaseTable = LeaseRow & { install_root: string };
export const leaseQueries = (db: HandoffDatabase) =>
  getNodeSqliteKysely<{ managed_update_handoffs: LeaseTable }>(db);

// Sealed lease consumers must not resolve installed publication dependencies.
const renameNoReplaceScript = () => `
  import fs from "node:fs";
  import { publishFileExclusive } from ${JSON.stringify(import.meta.resolve("@openclaw/fs-safe/durability"))};
  try {
    const input = JSON.parse(process.argv[1]);
    const source = fs.lstatSync(input.sourcePath);
    const parent = fs.lstatSync(input.parentPath);
    if (
      source.isSymbolicLink() ||
      !source.isFile() ||
      source.nlink !== 1 ||
      source.dev !== input.sourceIdentity.dev ||
      source.ino !== input.sourceIdentity.ino ||
      source.mode !== input.sourceIdentity.mode ||
      source.uid !== input.sourceIdentity.uid ||
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.dev !== input.parentIdentity.dev ||
      parent.ino !== input.parentIdentity.ino ||
      parent.mode !== input.parentIdentity.mode ||
      parent.uid !== input.parentIdentity.uid ||
      fs.realpathSync.native(input.parentPath) !== input.parentRealPath
    ) {
      throw Object.assign(new Error("publication input identity changed"), {
        code: "ESTALE",
      });
    }
    await publishFileExclusive({
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
      strategy: "rename-noreplace",
      expectedSourceIdentity: source,
      parentReceipt: {
        path: input.parentPath,
        realPath: input.parentRealPath,
        identity: parent,
      },
    });
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: typeof error?.code === "string" ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 2;
  }
`;

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
      .modifyEnd(sql`STRICT`),
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function renameNoReplaceSync(params: {
  sourcePath: string;
  targetPath: string;
  sourceIdentity: Stats;
  parentReceipt: DirectoryReceipt;
}): void {
  const input = JSON.stringify({
    sourcePath: params.sourcePath,
    targetPath: params.targetPath,
    sourceIdentity: {
      dev: params.sourceIdentity.dev,
      ino: params.sourceIdentity.ino,
      mode: params.sourceIdentity.mode,
      uid: params.sourceIdentity.uid,
    },
    parentPath: params.parentReceipt.path,
    parentRealPath: params.parentReceipt.realPath,
    parentIdentity: {
      dev: params.parentReceipt.identity.dev,
      ino: params.parentReceipt.identity.ino,
      mode: params.parentReceipt.identity.mode,
      uid: params.parentReceipt.identity.uid,
    },
  });
  const child = childProcess.spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", renameNoReplaceScript(), input],
    {
      encoding: "utf8",
      env: {},
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  if (child.error) {
    throw new Error("managed handoff lease publication helper failed", { cause: child.error });
  }
  let result: unknown;
  try {
    result = JSON.parse(child.stdout);
  } catch (error) {
    throw new Error("managed handoff lease publication helper returned an invalid result", {
      cause: error,
    });
  }
  if (!result || typeof result !== "object") {
    throw new Error("managed handoff lease publication helper returned an invalid result");
  }
  const ok = "ok" in result ? result.ok : undefined;
  const code = "code" in result && typeof result.code === "string" ? result.code : undefined;
  const message =
    "message" in result && typeof result.message === "string" ? result.message : undefined;
  if (child.status === 0 && ok === true && child.stderr === "") {
    return;
  }
  const failure = Object.assign(
    new Error(message ?? "managed handoff lease publication helper failed"),
    code ? { code } : {},
  );
  throw failure;
}

export type ManagedUpdateLeaseDatabaseIdentity = Readonly<{
  databasePath: string;
  databaseIdentity: string;
  parentIdentity: string;
}>;

function assertPath(stat: Stats, kind: "directory" | "file") {
  if (
    stat.isSymbolicLink() ||
    !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
    (kind === "file" && stat.nlink !== 1) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("managed handoff lease " + kind + " is unsafe");
  }
}

function assertSamePath(stat: Stats, expected: Stats, kind: "directory" | "file"): void {
  assertPath(stat, kind);
  if (
    (process.platform === "win32" &&
      (stat.dev === 0 || stat.ino === 0 || expected.dev === 0 || expected.ino === 0)) ||
    !sameFileIdentity(stat, expected)
  ) {
    throw new Error("managed handoff lease " + kind + " changed during initialization");
  }
}

function makePrivateStagingDirectory(dir: string): string {
  if (process.platform !== "win32") {
    return fs.mkdtempSync(path.join(dir, ".managed-update-handoffs-"));
  }
  const stagingDir = path.join(dir, `.managed-update-handoffs-${randomUUID()}`);
  createPrivateWindowsDirectory(stagingDir);
  return stagingDir;
}

function cleanupStagingDirectory(params: {
  stagingDir: string;
  stagingDirectoryIdentity: Stats;
  stagedDatabasePath?: string;
  stagedDatabaseIdentity?: Stats;
}): void {
  try {
    assertSamePath(fs.lstatSync(params.stagingDir), params.stagingDirectoryIdentity, "directory");
    if (params.stagedDatabasePath && params.stagedDatabaseIdentity) {
      try {
        const current = fs.lstatSync(params.stagedDatabasePath);
        if (!current.isSymbolicLink() && sameFileIdentity(current, params.stagedDatabaseIdentity)) {
          fs.unlinkSync(params.stagedDatabasePath);
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return;
        }
      }
    }
    assertSamePath(fs.lstatSync(params.stagingDir), params.stagingDirectoryIdentity, "directory");
    if (fs.readdirSync(params.stagingDir).length === 0) {
      fs.rmdirSync(params.stagingDir);
    }
  } catch {
    // An absent or changed staging path is no longer ours to remove.
  }
}

function initializeMissingDatabase(databasePath: string, parentReceipt: DirectoryReceipt): void {
  const dir = parentReceipt.path;
  const stagingDir = makePrivateStagingDirectory(dir);
  fs.chmodSync(stagingDir, 0o700);
  const stagingDirectoryIdentity = fs.lstatSync(stagingDir);
  assertPath(stagingDirectoryIdentity, "directory");
  const stagedDatabasePath = path.join(stagingDir, path.basename(databasePath));
  let stagedDatabaseIdentity: Stats | undefined;
  try {
    const stagedDatabase = openNodeSqliteDatabase(stagedDatabasePath, { readOnly: false });
    try {
      setSqliteBusyTimeout(stagedDatabase, 5000);
      initializeLeaseSchema(stagedDatabase);
    } finally {
      if (stagedDatabase.isOpen) {
        stagedDatabase.close();
      }
    }
    fs.chmodSync(stagedDatabasePath, 0o600);
    // Windows fsync requires write access after the SQLite handle closes.
    const descriptor = fs.openSync(
      stagedDatabasePath,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      stagedDatabaseIdentity = fs.fstatSync(descriptor);
      assertPath(stagedDatabaseIdentity, "file");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    assertSamePath(fs.lstatSync(dir), parentReceipt.identity, "directory");
    assertSamePath(fs.lstatSync(stagingDir), stagingDirectoryIdentity, "directory");
    assertSamePath(fs.lstatSync(stagedDatabasePath), stagedDatabaseIdentity, "file");
    if (fs.readdirSync(stagingDir).toSorted().join("\0") !== path.basename(databasePath)) {
      throw new Error("managed handoff lease staging directory contains unexpected files");
    }

    let published = true;
    try {
      renameNoReplaceSync({
        sourcePath: stagedDatabasePath,
        targetPath: databasePath,
        sourceIdentity: stagedDatabaseIdentity,
        parentReceipt,
      });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      published = false;
    }

    const canonicalIdentity = fs.lstatSync(databasePath);
    assertPath(canonicalIdentity, "file");
    if (published && !sameFileIdentity(canonicalIdentity, stagedDatabaseIdentity)) {
      throw new Error("managed handoff lease file changed during initialization");
    }
    assertSamePath(fs.lstatSync(dir), parentReceipt.identity, "directory");
    requireDirectorySync(syncDirectorySync(parentReceipt), "Managed handoff lease directory");
  } finally {
    cleanupStagingDirectory({
      stagingDir,
      stagingDirectoryIdentity,
      stagedDatabasePath,
      stagedDatabaseIdentity,
    });
  }
}

/** Capture only an already-admitted database, never provision one during recovery. */
export function captureManagedUpdateLeaseDatabaseIdentity(
  databasePath: string,
): ManagedUpdateLeaseDatabaseIdentity {
  const canonical = fs.realpathSync(databasePath);
  const file = fs.lstatSync(canonical);
  const parent = fs.lstatSync(path.dirname(canonical));
  assertPath(file, "file");
  assertPath(parent, "directory");
  return Object.freeze({
    databasePath: canonical,
    databaseIdentity: `${file.dev}:${file.ino}`,
    parentIdentity: `${parent.dev}:${parent.ino}`,
  });
}

export function assertManagedUpdateLeaseDatabaseIdentity(
  binding: ManagedUpdateLeaseDatabaseIdentity,
): void {
  const actual = captureManagedUpdateLeaseDatabaseIdentity(binding.databasePath);
  if (
    actual.databasePath !== binding.databasePath ||
    actual.databaseIdentity !== binding.databaseIdentity ||
    actual.parentIdentity !== binding.parentIdentity
  ) {
    throw new Error("managed handoff lease database identity changed");
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
  function withDatabase<T>(write: boolean, operation: (db: HandoffDatabase) => T): T {
    if (existingIdentity) {
      return withExistingSqliteRollbackDatabase(
        databasePath,
        {
          write,
          busyTimeoutMs: 5000,
          assertIdentity: () => assertManagedUpdateLeaseDatabaseIdentity(existingIdentity),
          validate: (db) => {
            executeSqliteQuerySync(
              db,
              leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().limit(0),
            );
          },
        },
        (db, transact) => {
          existingTransactions.set(db, transact);
          try {
            return operation(db);
          } finally {
            existingTransactions.delete(db);
          }
        },
      );
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
    const directoryIdentity = fs.lstatSync(dir);
    assertPath(directoryIdentity, "directory");
    if (write && !fs.existsSync(databasePath)) {
      initializeMissingDatabase(databasePath, {
        path: dir,
        realPath: fs.realpathSync.native(dir),
        identity: directoryIdentity,
      });
    } else {
      assertPath(fs.lstatSync(databasePath), "file");
    }
    const db = openNodeSqliteDatabase(
      write ? resolveExistingSqliteFileUri(databasePath) : databasePath,
      { readOnly: !write },
    );
    try {
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
