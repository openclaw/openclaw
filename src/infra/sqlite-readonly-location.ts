// Prepares consistent private SQLite read-only snapshots.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  copyFileDescriptorSync,
  sameFileContentsSync,
  sameFileIdentity,
} from "@openclaw/fs-safe/advanced";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { backupNodeSqliteDatabase } from "./sqlite-backup.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { withSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  retainSnapshotWork,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  PreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.types.js";
import {
  readSqliteSchemaHeader,
  readSqliteSchemaHeaderFromSnapshot,
} from "./sqlite-schema-header.js";
import {
  createSnapshotAttemptReporter,
  MAX_SNAPSHOT_ATTEMPTS,
  waitForSnapshotRetrySync,
} from "./sqlite-snapshot-policy.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
  sqliteSnapshotStagingError,
} from "./sqlite-snapshot-staging.js";
import { copySqliteWalPrefixSync } from "./sqlite-snapshot-wal-prefix.js";
import { withSqliteSourceReadDatabase } from "./sqlite-source-handle.js";

const SQLITE_HEADER_BYTES = 20;
const SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_READONLY_RESULT_CODE = 8;
const SQLITE_RESULT_CODE_MASK = 0xff;
const SQLITE_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

type PinnedFile = {
  descriptor: number;
  identity: BigIntStats;
  pathname: string;
};

type SourceSidecars = {
  journal: boolean;
  shm: boolean;
  wal: boolean;
};

type SourceJournalMode = "empty" | "rollback" | "unknown" | "wal";
export class SqliteSourceChangedError extends Error {}

function statIfPresent(pathname: string): BigIntStats | undefined {
  try {
    return fs.statSync(pathname, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function readSourceSidecars(pathname: string): SourceSidecars {
  return {
    journal: Boolean(statIfPresent(`${pathname}-journal`)),
    shm: Boolean(statIfPresent(`${pathname}-shm`)),
    wal: Boolean(statIfPresent(`${pathname}-wal`)),
  };
}

function sameSidecars(left: SourceSidecars, right: SourceSidecars): boolean {
  return left.journal === right.journal && left.shm === right.shm && left.wal === right.wal;
}

function openPinnedFile(pathname: string): PinnedFile {
  let descriptor: number;
  try {
    descriptor = fs.openSync(pathname, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SqliteSourceChangedError(`SQLite source disappeared: ${pathname}`);
    }
    throw error;
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const current = statIfPresent(pathname);
    if (!identity.isFile() || !current?.isFile() || !sameFileIdentity(identity, current)) {
      throw new SqliteSourceChangedError(`SQLite source changed while opening: ${pathname}`);
    }
    return { descriptor, identity, pathname };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function readSourceJournalMode(pathname: string): SourceJournalMode {
  const source = openPinnedFile(pathname);
  try {
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const bytesRead = fs.readSync(source.descriptor, header, 0, header.length, 0);
    const confirmedHeader = Buffer.alloc(SQLITE_HEADER_BYTES);
    const confirmedBytesRead = fs.readSync(
      source.descriptor,
      confirmedHeader,
      0,
      confirmedHeader.length,
      0,
    );
    assertPinnedIdentityUnchanged(source);
    if (bytesRead === 0 && confirmedBytesRead === 0) {
      return "empty";
    }
    if (
      bytesRead !== header.length ||
      confirmedBytesRead !== confirmedHeader.length ||
      !header.equals(confirmedHeader) ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      return "unknown";
    }
    return header[18] === 2 || header[19] === 2 ? "wal" : "rollback";
  } finally {
    fs.closeSync(source.descriptor);
  }
}

function assertPinnedIdentityUnchanged(file: PinnedFile): void {
  const opened = fs.fstatSync(file.descriptor, { bigint: true });
  const current = statIfPresent(file.pathname);
  if (
    !opened.isFile() ||
    !current?.isFile() ||
    !sameFileIdentity(file.identity, opened) ||
    !sameFileIdentity(file.identity, current)
  ) {
    throw new SqliteSourceChangedError(`SQLite source changed while copying: ${file.pathname}`);
  }
}

function copySourceFile(sourcePath: string, targetPath: string): void {
  const source = openPinnedFile(sourcePath);
  try {
    const target = fs.openSync(targetPath, "wx", 0o600);
    try {
      copyFileDescriptorSync(source.descriptor, target);
      fs.fsyncSync(target);
      assertPinnedIdentityUnchanged(source);
    } finally {
      fs.closeSync(target);
    }
  } finally {
    fs.closeSync(source.descriptor);
  }
}

function sourceMatchesCopy(sourcePath: string, copyPath: string): boolean {
  const source = openPinnedFile(sourcePath);
  let copy: number | undefined;
  try {
    copy = fs.openSync(copyPath, "r");
    if (!fs.fstatSync(copy).isFile()) {
      return false;
    }
    const equal = sameFileContentsSync(source.descriptor, copy);
    assertPinnedIdentityUnchanged(source);
    return equal;
  } finally {
    try {
      if (copy !== undefined) {
        fs.closeSync(copy);
      }
    } finally {
      fs.closeSync(source.descriptor);
    }
  }
}

function assertExpectedSidecars(pathname: string, expected: SourceSidecars): void {
  if (!sameSidecars(readSourceSidecars(pathname), expected)) {
    throw new SqliteSourceChangedError(`SQLite journal state changed while copying: ${pathname}`);
  }
}

export function isSqliteReadOnlyError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const details = current as { cause?: unknown; errcode?: unknown };
    if (
      typeof details.errcode === "number" &&
      (details.errcode & SQLITE_RESULT_CODE_MASK) === SQLITE_READONLY_RESULT_CODE
    ) {
      return true;
    }
    current = details.cause;
  }
  return false;
}

function rollbackJournalReferencesSuperJournal(journalPath: string): boolean {
  const descriptor = fs.openSync(journalPath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size < 16) {
      return false;
    }
    const trailer = Buffer.allocUnsafe(16);
    if (
      fs.readSync(descriptor, trailer, 0, trailer.length, size - trailer.length) !== trailer.length
    ) {
      return false;
    }
    const nameBytes = trailer.readUInt32BE(0);
    return (
      nameBytes > 0 && nameBytes <= size - 20 && trailer.subarray(8).equals(SQLITE_JOURNAL_MAGIC)
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoverPrivateJournalCopy(snapshotPath: string): void {
  if (rollbackJournalReferencesSuperJournal(`${snapshotPath}-journal`)) {
    throw new Error(
      `SQLite hot rollback journal references a super-journal and cannot be recovered privately: ${snapshotPath}`,
    );
  }
  const snapshot = openNodeSqliteDatabase(snapshotPath);
  try {
    snapshot.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
    // Read the header cookie without parsing sqlite_schema; the consumer owns
    // diagnostics and authorized repair of malformed catalogs.
    snapshot.prepare("PRAGMA schema_version;").get();
  } finally {
    snapshot.close();
  }
  fs.rmSync(`${snapshotPath}-journal`, { force: true });
  const descriptor = fs.openSync(snapshotPath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishPreparedCopy(directory: string): PreparedSqliteReadOnlyLocation {
  const location = path.join(directory, "database.sqlite");
  for (const suffix of ["-wal", "-shm", "-journal", ""]) {
    const staged = `${location}.partial${suffix}`;
    if (fs.existsSync(staged)) {
      fs.renameSync(staged, `${location}${suffix}`);
    }
  }
  return adoptPreparedLocation(location, directory);
}

function createStableReadOnlyCopyInTempDirectory(
  pathname: string,
  journalMode: SourceJournalMode,
  existingTempDir?: string,
  stagingRoot = existingTempDir
    ? path.dirname(existingTempDir)
    : resolvePrivateSqliteSnapshotStagingRoot(),
): PreparedSqliteReadOnlyLocation {
  let tempDir = existingTempDir;
  try {
    tempDir ??= createSqliteSnapshotStagingDirectorySync(stagingRoot);
    const snapshotPath = path.join(tempDir, "database.sqlite.partial");
    const firstPath = path.join(tempDir, "first");
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    if (readSourceJournalMode(pathname) !== journalMode) {
      throw new SqliteSourceChangedError(`SQLite journal mode changed before copying: ${pathname}`);
    }
    const sidecars = readSourceSidecars(pathname);
    let copiedWalPrefix = false;
    if (journalMode === "wal" && sidecars.wal && !sidecars.journal) {
      const walPath = `${pathname}-wal`;
      const wal = openPinnedFile(walPath);
      try {
        const copied = copySqliteWalPrefixSync(
          wal.descriptor,
          `${snapshotPath}-wal`,
          () => copySourceFile(pathname, snapshotPath),
          () => sourceMatchesCopy(pathname, snapshotPath),
        );
        assertPinnedIdentityUnchanged(wal);
        if (copied === false) {
          throw new SqliteSourceChangedError(
            `SQLite WAL generation changed while copying: ${pathname}`,
          );
        }
        copiedWalPrefix = copied === true;
      } finally {
        fs.closeSync(wal.descriptor);
      }
    }
    const sidecarSuffixes = [
      ...(sidecars.journal ? ["-journal"] : []),
      ...(sidecars.wal ? ["-wal"] : []),
    ];
    if (copiedWalPrefix) {
      assertExpectedSidecars(pathname, sidecars);
    } else if (sidecarSuffixes.length > 0) {
      for (const suffix of sidecarSuffixes) {
        copySourceFile(`${pathname}${suffix}`, `${snapshotPath}${suffix}`);
      }
      copySourceFile(pathname, snapshotPath);
      for (const suffix of sidecarSuffixes) {
        if (!sourceMatchesCopy(`${pathname}${suffix}`, `${snapshotPath}${suffix}`)) {
          const label = suffix === "-wal" ? "WAL" : "rollback journal";
          throw new SqliteSourceChangedError(`SQLite ${label} changed while copying: ${pathname}`);
        }
      }
      assertExpectedSidecars(pathname, sidecars);
    } else {
      copySourceFile(pathname, firstPath);
      assertExpectedSidecars(pathname, sidecars);
      const mainUnchanged = sourceMatchesCopy(pathname, firstPath);
      assertExpectedSidecars(pathname, sidecars);
      if (!mainUnchanged) {
        throw new SqliteSourceChangedError(
          `SQLite main database changed while copying: ${pathname}`,
        );
      }
      fs.rmSync(snapshotPath, { force: true });
      fs.renameSync(firstPath, snapshotPath);
    }

    if (readSourceJournalMode(pathname) !== journalMode) {
      throw new SqliteSourceChangedError(`SQLite journal mode changed while copying: ${pathname}`);
    }
    if (sidecars.journal) {
      // Journal filenames can coexist without activity. Let SQLite resolve the
      // verified private family; source recovery and sidecars remain untouched.
      recoverPrivateJournalCopy(snapshotPath);
    }
    return publishPreparedCopy(tempDir);
  } catch (error) {
    if (tempDir && existingTempDir === undefined) {
      removeTempDirectory(tempDir);
    }
    throw tempDir ? sqliteSnapshotStagingError(tempDir, error) : error;
  }
}

async function createStableReadOnlyCopy(
  pathname: string,
  journalMode: Exclude<SourceJournalMode, "unknown">,
  stagingRoot?: string,
  signal?: AbortSignal,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createSqliteSnapshotStagingDirectory(stagingRoot, false, signal);
  try {
    return createStableReadOnlyCopyInTempDirectory(pathname, journalMode, tempDir);
  } catch (error) {
    await removeTempDirectoryAsync(tempDir);
    throw error;
  }
}

/** Native reads may create WAL-index files; callers need an isolated child or a private source. */
export async function createOnlineReadOnlyBackup(
  pathname: string,
  stagingRoot?: string,
  signal?: AbortSignal,
  onProgress?: (progress: import("node:sqlite").BackupProgressInfo) => void,
): Promise<PreparedSqliteReadOnlyLocation> {
  const tempDir = await createSqliteSnapshotStagingDirectory(stagingRoot, false, signal);
  const snapshotPath = path.join(tempDir, "database.sqlite.partial");
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(tempDir, 0o700);
    }
    const source = withSqliteInspectionOperation("source", () =>
      openNodeSqliteDatabase(pathname, { readOnly: true }),
    );
    try {
      source.exec(
        `PRAGMA busy_timeout = ${SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF; BEGIN;`,
      );
      source.prepare("PRAGMA schema_version;").get();
      await retainSnapshotWork(backupNodeSqliteDatabase(source, snapshotPath, onProgress));
      source.exec("ROLLBACK;");
    } finally {
      if (source.isOpen) {
        source.close();
      }
    }
    const snapshot = openNodeSqliteDatabase(snapshotPath);
    try {
      snapshot.exec("PRAGMA journal_mode = DELETE;");
    } finally {
      snapshot.close();
    }
    const descriptor = fs.openSync(snapshotPath, "r+");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return publishPreparedCopy(tempDir);
  } catch (error) {
    await removeTempDirectoryAsync(tempDir);
    throw sqliteSnapshotStagingError(tempDir, error);
  }
}

/**
 * Active rollback and WAL state use SQLite's locking and backup protocol.
 * Crash residue that cannot be opened read-only is copied and recovered
 * privately so inspection never mutates coordination files beside the source.
 * In-process reads require drained source handles or a separate child: source
 * close() must not release another live SQLite owner's POSIX locks.
 */
async function prepareReadOnlySourceInProcess(
  pathname: string,
  stagingRoot?: string,
  signal?: AbortSignal,
  onProgress?: (progress: import("node:sqlite").BackupProgressInfo) => void,
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  const canonicalPath = fs.realpathSync.native(pathname);
  const report = createSnapshotAttemptReporter(canonicalPath, 0, performance.now());
  let operation: "raw-copy" | "online-backup" = "online-backup";
  try {
    const journalMode = readSourceJournalMode(canonicalPath);
    const sidecars = readSourceSidecars(canonicalPath);
    let prepared: PreparedSqliteReadOnlyLocation;
    if (journalMode === "empty" || (journalMode === "wal" && (!sidecars.wal || !sidecars.shm))) {
      // Incomplete inactive families need one private recovery copy so opening
      // SQLite cannot create or recover coordination files beside the source.
      operation = "raw-copy";
      prepared = await createStableReadOnlyCopy(canonicalPath, journalMode, stagingRoot, signal);
    } else {
      try {
        prepared = await createOnlineReadOnlyBackup(canonicalPath, stagingRoot, signal, onProgress);
      } catch (error) {
        signal?.throwIfAborted();
        if (
          !isSqliteReadOnlyError(error) ||
          readSourceJournalMode(canonicalPath) !== "rollback" ||
          !readSourceSidecars(canonicalPath).journal
        ) {
          throw error;
        }
        // Hot rollback recovery must operate on private files. A native
        // read-only open refuses before backup starts, so this is the only copy.
        operation = "raw-copy";
        prepared = await createStableReadOnlyCopy(canonicalPath, "rollback", stagingRoot, signal);
      }
    }
    report(operation, "success", prepared);
    return prepared;
  } catch (error) {
    report(operation, "error", undefined, error);
    throw error;
  }
}

function prepareReadOnlySourceSyncInProcess(
  pathname: string,
  stagingRoot?: string,
): PreparedSqliteReadOnlyLocation {
  const canonicalPath = fs.realpathSync.native(pathname);
  let lastChange: Error | undefined;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const journalMode = readSourceJournalMode(canonicalPath);
      // Stable malformed bytes still belong to SQLite's diagnostic path. The
      // private copy checks bytes, sidecars, and mode before a reader opens it.
      return createStableReadOnlyCopyInTempDirectory(
        canonicalPath,
        journalMode,
        undefined,
        stagingRoot,
      );
    } catch (error) {
      if (!(error instanceof SqliteSourceChangedError)) {
        throw error;
      }
      lastChange = error;
      waitForSnapshotRetrySync(attempt);
    }
  }
  throw new SqliteSourceChangedError(
    `SQLite source did not stabilize after ${MAX_SNAPSHOT_ATTEMPTS} read-only inspection attempts (the database may be under concurrent write activity): ${canonicalPath}. Wait a moment for write activity to settle, then retry the inspection`,
    {
      cause: lastChange,
    },
  );
}

/** Fixed metadata inspection in the read-only child; no payload scan or backup
 * unless source journal state requires private recovery/artifact preservation. */
export async function inspectSqliteSchemaHeaderInProcess(
  pathname: string,
  stagingRoot?: string,
  agentSchemaVersionForOwnership?: number,
) {
  const canonicalPath = fs.realpathSync.native(pathname);
  const mode = readSourceJournalMode(canonicalPath);
  const sidecars = readSourceSidecars(canonicalPath);
  if (mode !== "wal" || (sidecars.wal && sidecars.shm)) {
    let readError: unknown;
    try {
      return withSqliteSourceReadDatabase(canonicalPath, "source", (database) => {
        try {
          setSqliteBusyTimeout(database, SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS);
          return readSqliteSchemaHeader(database, agentSchemaVersionForOwnership);
        } catch (error) {
          readError = error;
          throw error;
        }
      });
    } catch (error) {
      // Only SQLite's recovery-required refusal permits private recovery.
      // Ordinary I/O, admission, and native close errors must stay failures.
      if (
        error !== readError ||
        !isSqliteReadOnlyError(error) ||
        !statIfPresent(`${canonicalPath}-journal`) ||
        readSourceJournalMode(canonicalPath) !== "rollback"
      ) {
        throw error;
      }
    }
  }
  // An incomplete WAL family would create source sidecars on native open.
  // The existing snapshot owner also handles hot rollback recovery privately.
  const prepared = await prepareReadOnlySourceInProcess(canonicalPath, stagingRoot);
  return readSqliteSchemaHeaderFromSnapshot(prepared, undefined, agentSchemaVersionForOwnership);
}

export function prepareSqliteReadOnlyLocationInProcess(
  pathname: string,
  stagingRoot?: string,
  signal?: AbortSignal,
  onProgress?: (progress: import("node:sqlite").BackupProgressInfo) => void,
) {
  signal?.throwIfAborted();
  return prepareReadOnlySourceInProcess(pathname, stagingRoot, signal, onProgress);
}

export function prepareSqliteReadOnlyLocationSyncInProcess(pathname: string, stagingRoot?: string) {
  return prepareReadOnlySourceSyncInProcess(pathname, stagingRoot);
}

/** Snapshot the lifecycle owner's already-open native connection. Opening or
 * closing another source descriptor could release its process-wide POSIX locks.
 * Only the private destination is opened/closed here; the source owner retains it. */
export function prepareSqliteReadOnlyLocationFromOwnedDatabase(
  database: DatabaseSync,
  assertCurrent: () => void,
  signal: AbortSignal | undefined,
  cleanupMode: "async",
): Promise<AsyncPreparedSqliteReadOnlyLocation>;
export function prepareSqliteReadOnlyLocationFromOwnedDatabase(
  database: DatabaseSync,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<PreparedSqliteReadOnlyLocation>;
export async function prepareSqliteReadOnlyLocationFromOwnedDatabase(
  database: DatabaseSync,
  assertCurrent: () => void,
  signal?: AbortSignal,
  cleanupMode?: "async",
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  assertCurrent();
  if (!database.isOpen || database.isTransaction) {
    throw new Error("SQLite inspection requires an open owner outside a transaction");
  }
  const directory = await createSqliteSnapshotStagingDirectory(
    undefined,
    false,
    signal,
    cleanupMode === "async",
  );
  try {
    signal?.throwIfAborted();
    assertCurrent();
    if (!database.isOpen || database.isTransaction) {
      throw new Error("SQLite inspection requires an open owner outside a transaction");
    }
    const location = path.join(directory, "database.sqlite.partial");
    await retainSnapshotWork(backupNodeSqliteDatabase(database, location));
    signal?.throwIfAborted();
    assertCurrent();
    return publishPreparedCopy(directory);
  } catch (error) {
    const errors: unknown[] = [error];
    const removed = await removeTempDirectoryAsync(directory, (cleanupError) =>
      errors.push(cleanupError),
    );
    if (!removed && cleanupMode === "async") {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Owned SQLite snapshot preparation and cleanup failed",
        error,
      );
    }
    throw error;
  }
}
