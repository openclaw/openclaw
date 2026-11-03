import fs from "node:fs";
import path from "node:path";
import { tryReadDiskSpace } from "./disk-space.js";
import {
  isPrivateDirectoryCreationRefused,
  markPrivateDirectoryCreationRefused,
} from "./private-directory-creation.js";
import { markSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import {
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  registerSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
  retainSnapshotWork,
  SqliteSnapshotCleanupError,
  retireSqliteSnapshotPayload,
} from "./sqlite-readonly-location-cleanup.js";
import { sqliteSnapshotSourceFileSize } from "./sqlite-snapshot-policy.js";
import {
  acquireSqliteSnapshotToken as snapshotToken,
  beginSqliteSnapshotRetirement,
  SQLITE_SNAPSHOT_PREFIX as prefix,
} from "./sqlite-snapshot-retirement.js";
import type { SqliteStagingToken as SnapshotToken } from "./sqlite-staging-token.js";

/** A private reader protects its bytes independently of the staging child. */
export function acquireSqliteSnapshotReadToken(directory: string): () => void {
  return snapshotToken(directory, "read");
}

/** Reconcile only after the token process closed; active readers still fence reclamation. */
export function reconcileSqliteSnapshotRetirement(directory: string): void {
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) {
    return;
  }
  // Explicit retirement has confirmed owner exit; nested legacy layouts keep their age clamp.
  const retirement = beginSqliteSnapshotRetirement(directory, { cutoff: Number.POSITIVE_INFINITY });
  try {
    for (const _ of retireSqliteSnapshotPayload(retirement)) {
      // Synchronous reconciliation keeps the token until all bounded steps settle.
    }
  } finally {
    retirement.release();
  }
}

export function sqliteSnapshotStagingError(
  tempDir: string,
  cause: unknown,
  allocation = false,
  sourcePath?: string,
): unknown {
  markSqliteInspectionOperation(cause, "snapshot");
  let destination = allocation;
  let capacity = false;
  let sqliteErrcode: number | undefined;
  for (let depth = 0, error = cause; depth < 8 && error instanceof Error; depth += 1) {
    const { code, errcode, path: errorPath }: NodeJS.ErrnoException & { errcode?: unknown } = error;
    // SQLite FULL and IOERR_WRITE/FSYNC/DIR_FSYNC identify destination writes.
    capacity ||= ["ENOSPC", "EDQUOT"].includes(code ?? "") || errcode === 13;
    if (
      capacity ||
      (typeof errcode === "number" && [13, 778, 1034, 1290].includes(errcode)) ||
      `${errorPath ?? ""}${path.sep}`.startsWith(`${tempDir}${path.sep}`)
    ) {
      destination = true;
      if (typeof errcode === "number") {
        sqliteErrcode = errcode;
      }
    }
    error = error.cause;
  }
  if (!destination) {
    return cause;
  }
  const guidance = capacity
    ? "free disk space/quota"
    : "check filesystem health and write permissions";
  let capacityDetail = "";
  if (capacity && sourcePath) {
    try {
      const estimatedBytes =
        sqliteSnapshotSourceFileSize(sourcePath) +
        sqliteSnapshotSourceFileSize(`${sourcePath}-wal`) +
        sqliteSnapshotSourceFileSize(`${sourcePath}-journal`);
      const availableBytes = tryReadDiskSpace(tempDir)?.availableBytes;
      const liveWal = fs.existsSync(`${sourcePath}-wal`) && fs.existsSync(`${sourcePath}-shm`);
      capacityDetail = `; estimated ${estimatedBytes} bytes needed; ${availableBytes === undefined ? "available bytes unknown" : `${availableBytes} bytes available`}; source ${liveWal ? "has live WAL sidecars" : "has no live WAL sidecars"}`;
    } catch {
      // A failed capacity observation must preserve the original storage error.
    }
  }
  const selector = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" ? "TMPDIR" : "XDG_CACHE_HOME";
  const message = `${cause instanceof Error ? cause.message : String(cause)}${sqliteErrcode !== undefined ? ` (SQLite errcode=${sqliteErrcode})` : ""}; snapshot staging root ${allocation ? tempDir : path.dirname(tempDir)}${capacityDetail}: ${guidance} or set ${selector} to a writable filesystem`;
  const error = new Error(message, { cause });
  return isPrivateDirectoryCreationRefused(cause)
    ? markPrivateDirectoryCreationRefused(error)
    : error;
}

export async function createSqliteSnapshotStagingDirectory(
  stagingRoot = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
  signal?: AbortSignal,
  asynchronousCleanup = false,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    return await allocateSqliteSnapshotStagingDirectory(
      stagingRoot,
      allowLegacyWorker,
      signal,
      asynchronousCleanup,
    );
  } catch (error) {
    if (
      error instanceof SqliteSnapshotCleanupError ||
      (asynchronousCleanup && error instanceof AggregateError)
    ) {
      throw error;
    }
    signal?.throwIfAborted();
    markSqliteInspectionOperation(error, "snapshot");
    throw error;
  }
}

async function allocateSqliteSnapshotStagingDirectory(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
  signal?: AbortSignal,
  asynchronousCleanup = false,
): Promise<string> {
  signal?.throwIfAborted();
  if (asynchronousCleanup) {
    const controller = new AbortController();
    return retainSnapshotWork(
      (async () => {
        const { allocateWorkerOwnedSqliteSnapshotDirectory } =
          await import("./sqlite-snapshot-staging-allocation.js");
        signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        const owned = await allocateWorkerOwnedSqliteSnapshotDirectory(
          root,
          allowLegacyWorker,
          signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        );
        registerSnapshotTempDirectory(owned.directory);
        if (signal?.aborted || controller.signal.aborted) {
          if (!(await removeTempDirectoryAsync(owned.directory))) {
            throw new SqliteSnapshotCleanupError(
              `SQLite snapshot cleanup failed: ${owned.directory}`,
            );
          }
          signal?.throwIfAborted();
          controller.signal.throwIfAborted();
        }
        return owned.directory;
      })(),
      () => controller.abort(new Error("SQLite snapshot allocation stopped")),
    );
  }
  return createSqliteSnapshotStagingDirectorySync(root, allowLegacyWorker);
}

export function createSqliteSnapshotStagingDirectorySync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
): string {
  const owned = createSqliteSnapshotStagingTokenSync(root, allowLegacyWorker);
  registerSnapshotTempDirectory(owned.directory, owned.release);
  return owned.directory;
}

/** Token workers remove disposable payload under their own native retirement fences. */
export function createSqliteSnapshotStagingTokenSync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
): { directory: string; release: SnapshotToken } {
  let directory: string | undefined;
  try {
    // A selected installation may launch a worker without token admission.
    try {
      directory = createPrivateSqliteTempDirectorySync(
        root,
        allowLegacyWorker ? `openclaw-sqlite-readonly-${process.pid}-` : prefix,
      );
    } catch (error) {
      // Preserve allocation context before worker IPC reduces errors to messages.
      // Launch and token-admission failures are not directory write failures.
      throw sqliteSnapshotStagingError(root, error, true);
    }
    return { directory, release: snapshotToken(directory, "create") };
  } catch (error) {
    if (directory) {
      removeTempDirectory(directory);
    }
    throw error;
  }
}
