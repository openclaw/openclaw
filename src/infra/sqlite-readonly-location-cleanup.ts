import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { registerSignalExitFinalizer } from "../cli/signal-exit-barrier.js";
import { getChildLogger } from "../logging/logger.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  beginSqliteSnapshotRetirement,
  drainPendingSqliteSnapshotTokens,
} from "./sqlite-snapshot-retirement.js";
import { SQLITE_STAGING_TOKEN_FILES, type SqliteStagingToken } from "./sqlite-staging-token.js";

export class SqliteSnapshotCleanupError extends Error {}

type SnapshotDirectory = {
  release?: SqliteStagingToken;
  releaseAsync?: () => Promise<void>;
  retiring?: Promise<void>;
  retirementStarted?: boolean;
  retired?: boolean;
  readers: Set<symbol>;
};
const pendingTempDirectoryCleanup = new Map<string, SnapshotDirectory>();
let cleanupExitHandlerInstalled = false;
const activeSnapshotWork = new Map<Promise<unknown>, () => void>();
let pendingSignalCleanup: Promise<void> | undefined;

function snapshotDirectory(directory: string): SnapshotDirectory {
  let owner = pendingTempDirectoryCleanup.get(directory);
  if (!owner) {
    owner = { readers: new Set() };
    pendingTempDirectoryCleanup.set(directory, owner);
  }
  return owner;
}

export function cleanupSnapshotOperations(): Promise<void> {
  pendingSignalCleanup ??= (async () => {
    const directories = pendingTempDirectoryCleanup.keys();
    while (true) {
      while (activeSnapshotWork.size > 0) {
        for (const stop of activeSnapshotWork.values()) {
          stop();
        }
        await Promise.allSettled(activeSnapshotWork.keys());
      }
      // Removal yields: join readers admitted during it before selecting more bytes.
      const next = directories.next();
      if (next.done) {
        break;
      }
      const directory = next.value;
      await removeTempDirectoryAsync(directory, (error) =>
        emitSnapshotCleanupFailure({
          cleanupRoot: directory,
          operation: "rm",
          code: extractErrorCode(error),
        }),
      );
    }
  })().finally(() => {
    pendingSignalCleanup = undefined;
  });
  return pendingSignalCleanup;
}

/** Join native backup work or a terminated child before removing its private bytes. */
export function retainSnapshotWork<T>(work: Promise<T>, stop: () => void = () => {}): Promise<T> {
  registerSignalExitFinalizer(cleanupSnapshotOperations);
  activeSnapshotWork.set(work, stop);
  const release = () => activeSnapshotWork.delete(work);
  void work.then(release, release);
  return work;
}

export function registerSnapshotTempDirectory(
  directory: string,
  release?: SqliteStagingToken,
): void {
  const owner = snapshotDirectory(directory);
  owner.release = release ?? owner.release;
  if (!cleanupExitHandlerInstalled) {
    cleanupExitHandlerInstalled = true;
    process.once("exit", () => {
      for (const stop of activeSnapshotWork.values()) {
        stop();
      }
      // A surviving child retains its kernel token; the next owner reclaims it.
      if (activeSnapshotWork.size === 0) {
        for (const pendingDir of pendingTempDirectoryCleanup.keys()) {
          removeTempDirectory(pendingDir);
        }
      }
    });
  }
  registerSignalExitFinalizer(cleanupSnapshotOperations);
}

/** Async readers keep token custody on their staging worker until removal. */
export function registerAsyncSnapshotTempDirectory(
  directory: string,
  release: () => Promise<void>,
): void {
  registerSnapshotTempDirectory(directory);
  snapshotDirectory(directory).releaseAsync = release;
}

/** Rejection is not retirement: only the reader's successful close releases custody. */
export function retainSnapshotTempDirectory(directory: string): () => void {
  registerSnapshotTempDirectory(directory);
  const owner = snapshotDirectory(directory);
  if (owner.retirementStarted) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot retirement has started");
  }
  const reader = Symbol("sqlite.snapshot.reader");
  owner.readers.add(reader);
  return () => owner.readers.delete(reader);
}

/** A successful child hands its files to the caller's enclosing staging owner. */
export function releaseSnapshotTempDirectory(directory: string): void {
  const owner = pendingTempDirectoryCleanup.get(directory);
  assertSnapshotReadersRetired(owner);
  if (owner?.releaseAsync) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot requires asynchronous cleanup");
  }
  owner?.release?.(false);
  pendingTempDirectoryCleanup.delete(directory);
}
const tempDirectoryRemovalOptions = {
  force: true,
  maxRetries: 3,
  recursive: true,
  retryDelay: 20,
} as const;

// A non-throwing cleanup-failure report emitted once per owner; a successful
// read is never turned into a failure by temp-file cleanup.
export type CleanupFailureReport = {
  cleanupRoot: string;
  operation: "rm";
  code: string | undefined;
};

function emitSnapshotCleanupFailure(
  report: CleanupFailureReport,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): void {
  if (onCleanupFailure) {
    try {
      onCleanupFailure(report);
      return;
    } catch {
      // A failed consumer diagnostic still belongs in the shared log sink.
    }
  }
  try {
    // File/diagnostic transports preserve subprocess stdout/stderr result contracts.
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
      { path: report.cleanupRoot, operation: report.operation, errorCode: report.code },
      "SQLite read-only snapshot cleanup failed. Check directory permissions and available storage before retrying.",
    );
  } catch {
    // Diagnostic failures must not replace the read's result or original error.
  }
}

function assertSnapshotReadersRetired(owner: SnapshotDirectory | undefined): void {
  if (owner?.readers.size) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot still belongs to an active reader");
  }
}

function prepareSnapshotRetirement(directory: string) {
  drainPendingSqliteSnapshotTokens(directory);
  const owner = pendingTempDirectoryCleanup.get(directory);
  assertSnapshotReadersRetired(owner);
  if (owner?.releaseAsync) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot requires asynchronous cleanup");
  }
  if (
    owner?.retired ||
    (!owner?.release && !fs.existsSync(path.join(directory, SQLITE_STAGING_TOKEN_FILES[0])))
  ) {
    return undefined;
  }
  if (owner) {
    owner.retirementStarted = true;
  }
  return beginSqliteSnapshotRetirement(directory, { token: owner?.release });
}

/** Delete in the token process: owner death must stop unlinking when its locks disappear. */
export function retireSqliteSnapshotPayload(
  retirement: ReturnType<typeof beginSqliteSnapshotRetirement>,
): void {
  for (const file of retirement.payload) {
    fs.rmSync(file, tempDirectoryRemovalOptions);
  }
  // Free copied bytes before SQLite allocates its retirement page/journal.
  // Controls stay intact until every marker commits and native handle closes.
  retirement.retire();
}

export function removeTempDirectory(
  tempDir: string,
  onFailure?: (error: unknown) => void,
): boolean {
  try {
    const retirement = prepareSnapshotRetirement(tempDir);
    try {
      if (retirement) {
        retireSqliteSnapshotPayload(retirement);
        const owner = snapshotDirectory(tempDir);
        owner.release = undefined;
        owner.retired = true;
      }
      fs.rmSync(tempDir, tempDirectoryRemovalOptions);
    } finally {
      retirement?.release();
    }
    pendingTempDirectoryCleanup.delete(tempDir);
    return true;
  } catch (error) {
    onFailure?.(error);
    registerSnapshotTempDirectory(tempDir);
    return false;
  }
}

export async function removeTempDirectoryAsync(
  tempDir: string,
  onFailure?: (error: unknown) => void,
): Promise<boolean> {
  try {
    const owner = pendingTempDirectoryCleanup.get(tempDir);
    assertSnapshotReadersRetired(owner);
    if (owner?.releaseAsync) {
      owner.retirementStarted = true;
      await (owner.retiring ??= owner
        .releaseAsync()
        .then(() => {
          owner.releaseAsync = undefined;
          owner.retired = true;
        })
        .finally(() => {
          owner.retiring = undefined;
        }));
    }
    const retirement = prepareSnapshotRetirement(tempDir);
    try {
      for (const file of retirement?.payload ?? []) {
        await retainSnapshotWork(fs.promises.rm(file, tempDirectoryRemovalOptions));
      }
      if (retirement) {
        retirement.retire();
        const current = snapshotDirectory(tempDir);
        current.release = undefined;
        current.retired = true;
      }
      await retainSnapshotWork(fs.promises.rm(tempDir, tempDirectoryRemovalOptions));
    } finally {
      retirement?.release();
    }
    pendingTempDirectoryCleanup.delete(tempDir);
    return true;
  } catch (error) {
    onFailure?.(error);
    registerSnapshotTempDirectory(tempDir);
    return false;
  }
}

export function adoptPreparedLocation(
  location: string,
  ownedRoot?: string,
  requireCleanup = false,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): PreparedSqliteReadOnlyLocation {
  const tempDir = ownedRoot ?? path.dirname(location);
  registerSnapshotTempDirectory(tempDir);
  let active = true;
  let pending: Promise<boolean> | undefined;
  let reported = false;
  const reportFailure = (error: unknown) => {
    if (!requireCleanup && !reported) {
      reported = true;
      emitSnapshotCleanupFailure(
        { cleanupRoot: tempDir, operation: "rm", code: extractErrorCode(error) },
        onCleanupFailure,
      );
    }
  };
  const complete = (removed: boolean) => {
    if (removed) {
      active = false;
    } else if (requireCleanup) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${tempDir}`);
    }
    return removed;
  };
  return {
    location,
    cleanupRoot: tempDir,
    cleanup: () => {
      if (pending) {
        // Pending async removal: return false without a false warning;
        // requireCleanup delegates to complete(false) for the fatal throw.
        return requireCleanup ? complete(false) : false;
      }
      if (!active) {
        return true;
      }
      return complete(removeTempDirectory(tempDir, reportFailure));
    },
    cleanupAsync: () => {
      if (pending) {
        return pending;
      }
      if (!active) {
        return Promise.resolve(true);
      }
      // Register ownership before invoking native removal; concurrent callers
      // join it, and synchronous callers cannot race or report early success.
      pending = Promise.resolve()
        .then(() => removeTempDirectoryAsync(tempDir, reportFailure))
        .then(complete)
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
