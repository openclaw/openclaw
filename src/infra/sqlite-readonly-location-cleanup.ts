import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  createRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { registerSignalExitFinalizer } from "../cli/signal-exit-barrier.js";
import { getChildLogger } from "../logging/logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { retireSqliteDatabaseAdmissionForPath } from "./sqlite-database-admission.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
} from "./sqlite-readonly-location.types.js";
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
import { SQLITE_STAGING_TOKEN_FILES, type SqliteStagingToken } from "./sqlite-staging-token.js";

export class SqliteSnapshotCleanupError extends Error {}

/** A failed result does not discharge the original request's native cleanup custody. */
export function settleSqliteSnapshotRequest<T>(request: {
  result: Promise<T>;
  startClose(): RetainedOperation<void>;
}): Promise<T> {
  return request.result.catch(async (error: unknown) => {
    try {
      await request.startClose().result;
    } catch (cleanupError) {
      if (cleanupError === error) {
        throw error;
      }
      const combined = createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite snapshot allocation and cleanup failed",
        error,
      );
      throw error instanceof SqliteSnapshotCleanupError
        ? new SqliteSnapshotCleanupError(error.message, { cause: combined })
        : combined;
    }
    throw error;
  });
}

type SnapshotDirectory = {
  release?: SqliteStagingToken;
  releaseRetained?: () => RetainedOperation<void>;
  retiringRetained?: RetainedOperation<boolean>;
  retirementStarted?: boolean;
  retired?: boolean;
  readers: Set<symbol>;
};
type SnapshotCleanupState = {
  directories: Map<string, SnapshotDirectory>;
  activeWork: Map<Promise<unknown>, () => void>;
  exitHandlerInstalled: boolean;
  pendingSignalCleanup: Promise<void> | undefined;
  signalCleanup: () => Promise<void>;
};
// Reader and producer lifetimes share one cleanup registry.
const cleanupState = resolveGlobalSingleton<SnapshotCleanupState>(
  Symbol.for("openclaw.sqliteSnapshotCleanup"),
  () => ({
    directories: new Map<string, SnapshotDirectory>(),
    activeWork: new Map<Promise<unknown>, () => void>(),
    exitHandlerInstalled: false,
    pendingSignalCleanup: undefined,
    signalCleanup: cleanupSnapshotOperations,
  }),
);
const snapshotDirectories = cleanupState.directories;
const activeSnapshotWork = cleanupState.activeWork;
function snapshotDirectory(directory: string): SnapshotDirectory {
  let owner = snapshotDirectories.get(directory);
  if (!owner) {
    owner = { readers: new Set() };
    snapshotDirectories.set(directory, owner);
  }
  return owner;
}

function completeSnapshotDirectoryRemoval(directory: string) {
  snapshotDirectories.delete(directory);
  return true;
}

export function cleanupSnapshotOperations(): Promise<void> {
  cleanupState.pendingSignalCleanup ??= (async () => {
    const directories = snapshotDirectories.entries();
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
      const [directory] = next.value;
      await removeTempDirectoryAsync(directory, (error) =>
        emitSnapshotCleanupFailure({
          cleanupRoot: directory,
          operation: "rm",
          code: extractErrorCode(error),
        }),
      );
    }
  })().finally(() => {
    cleanupState.pendingSignalCleanup = undefined;
  });
  return cleanupState.pendingSignalCleanup;
}

/** Join native backup work or a terminated child before removing its private bytes. */
export function retainSnapshotWork<T>(work: Promise<T>, stop: () => void = () => {}): Promise<T> {
  registerSnapshotCleanup();
  activeSnapshotWork.set(work, stop);
  const release = () => activeSnapshotWork.delete(work);
  void work.then(release, release);
  return work;
}

/** Keep signal cleanup behind the consumer, including private transforms and publication. */
export async function withPreparedSqliteSnapshot<T>(
  snapshot: PreparedSqliteReadOnlyLocation,
  read: (location: string) => T | Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { cause: unknown };
  try {
    outcome = {
      value: await retainSnapshotWork(Promise.resolve().then(() => read(snapshot.location))),
    };
  } catch (cause) {
    outcome = { cause };
  }
  if (!(await snapshot.cleanupAsync().catch(() => false))) {
    // An exit retry is best-effort, not proof that this private copy was removed.
    const readFailure =
      "cause" in outcome
        ? `${outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)}; `
        : "";
    throw new Error(
      `${readFailure}SQLite snapshot cleanup failed: ${snapshot.cleanupRoot ?? path.dirname(snapshot.location)}. Check directory permissions and available storage before retrying.`,
      "cause" in outcome ? outcome : undefined,
    );
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

export function registerSnapshotTempDirectory(
  directory: string,
  release?: SqliteStagingToken,
): void {
  const owner = snapshotDirectory(directory);
  owner.release = release ?? owner.release;
  registerSnapshotCleanup();
}

function registerSnapshotCleanup(): void {
  if (!cleanupState.exitHandlerInstalled) {
    cleanupState.exitHandlerInstalled = true;
    process.once("exit", () => {
      for (const stop of activeSnapshotWork.values()) {
        stop();
      }
      // A surviving child retains its kernel token; the next owner reclaims it.
      if (activeSnapshotWork.size === 0) {
        for (const pendingDir of snapshotDirectories.keys()) {
          removeTempDirectory(pendingDir);
        }
      }
    });
  }
  registerSignalExitFinalizer(cleanupState.signalCleanup);
}

/** This owner joins token retirement and directory removal in its worker. */
export function registerRetainedSnapshotTempDirectory(
  directory: string,
  release: () => RetainedOperation<void>,
): void {
  snapshotDirectory(directory).releaseRetained = release;
  registerSnapshotCleanup();
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
  const owner = snapshotDirectories.get(directory);
  assertSnapshotReadersRetired(owner);
  if (owner?.releaseRetained) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot requires asynchronous cleanup");
  }
  owner?.release?.(false);
  snapshotDirectories.delete(directory);
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

function prepareSnapshotRetirement(directory: string, owner: SnapshotDirectory | undefined) {
  assertSnapshotReadersRetired(owner);
  if (owner?.releaseRetained) {
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
    retireSqliteDatabaseAdmissionForPath(file);
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
  let owner = snapshotDirectories.get(tempDir);
  try {
    const retirement = prepareSnapshotRetirement(tempDir, owner);
    try {
      if (retirement) {
        retireSqliteSnapshotPayload(retirement);
        owner = snapshotDirectory(tempDir);
        owner.release = undefined;
        owner.retired = true;
      }
      fs.rmSync(tempDir, tempDirectoryRemovalOptions);
    } finally {
      retirement?.release();
    }
    return completeSnapshotDirectoryRemoval(tempDir);
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
  let owner = snapshotDirectories.get(tempDir);
  if (owner?.releaseRetained) {
    const removed = await startRemoveTempDirectory(tempDir, onFailure, owner).result;
    if (removed) {
      snapshotDirectories.delete(tempDir);
    }
    return removed;
  }
  try {
    assertSnapshotReadersRetired(owner);
    const retirement = prepareSnapshotRetirement(tempDir, owner);
    try {
      for (const file of retirement?.payload ?? []) {
        retireSqliteDatabaseAdmissionForPath(file);
        await retainSnapshotWork(fs.promises.rm(file, tempDirectoryRemovalOptions));
      }
      if (retirement) {
        retirement.retire();
        owner = snapshotDirectory(tempDir);
        owner.release = undefined;
        owner.retired = true;
      }
      await retainSnapshotWork(fs.promises.rm(tempDir, tempDirectoryRemovalOptions));
    } finally {
      retirement?.release();
    }
    return completeSnapshotDirectoryRemoval(tempDir);
  } catch (error) {
    onFailure?.(error);
    registerSnapshotTempDirectory(tempDir);
    return false;
  }
}

export function startRemoveTempDirectory(
  directory: string,
  onFailure?: (error: unknown) => void,
  owner = snapshotDirectories.get(directory),
): RetainedOperation<boolean> {
  if (owner?.retiringRetained) {
    return owner.retiringRetained;
  }
  let release: RetainedOperation<void> | undefined;
  const retained = createRetainedOperation<boolean>(() => {
    if (!release || retained.operation.read().status !== "pending") {
      return;
    }
    release.service();
    const outcome = release.read();
    if (outcome.status === "pending") {
      return;
    }
    if (owner) {
      owner.retiringRetained = undefined;
    }
    if (outcome.status === "rejected") {
      onFailure?.(outcome.error);
      retained.resolve(false);
    } else {
      retained.resolve(completeSnapshotDirectoryRemoval(directory));
    }
  });
  try {
    sealRetainedSnapshotTempDirectory(directory);
    if (!owner?.releaseRetained) {
      throw new SqliteSnapshotCleanupError("SQLite snapshot has no retained cleanup owner");
    }
    owner.retiringRetained = retained.operation;
    release = owner.releaseRetained();
    void release.result.then(
      () => retained.operation.service(),
      () => retained.operation.service(),
    );
    retained.operation.service();
  } catch (error) {
    if (owner) {
      owner.retiringRetained = undefined;
    }
    onFailure?.(error);
    retained.resolve(false);
  }
  return retained.operation;
}

/** A surviving native owner may retire bytes only after their original host readers leave. */
export function sealRetainedSnapshotTempDirectory(
  directory: string,
  options?: { requireRequested: true },
): void {
  const owner = snapshotDirectories.get(directory);
  if (!owner?.releaseRetained) {
    throw new SqliteSnapshotCleanupError("SQLite snapshot has no retained cleanup owner");
  }
  if (options?.requireRequested && !owner.retirementStarted) {
    throw new SqliteSnapshotCleanupError(
      "SQLite snapshot is still owned; cleanup has not been requested",
    );
  }
  assertSnapshotReadersRetired(owner);
  owner.retirementStarted = true;
}

export function adoptPreparedLocation(
  location: string,
  ownedRoot?: string,
  requireCleanup = false,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): PreparedSqliteReadOnlyLocation {
  return adoptRetainedPreparedLocation(location, ownedRoot, requireCleanup, onCleanupFailure);
}

export function adoptRetainedPreparedLocation(
  location: string,
  ownedRoot?: string,
  requireCleanup = false,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation {
  const tempDir = ownedRoot ?? path.dirname(location);
  registerSnapshotTempDirectory(tempDir);
  let active = true;
  let pending: Promise<boolean> | undefined;
  let retainedCleanup: RetainedOperation<boolean> | undefined;
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
      snapshotDirectories.delete(tempDir);
    } else if (requireCleanup) {
      throw new SqliteSnapshotCleanupError(
        `SQLite read-only worker snapshot cleanup failed: ${tempDir}`,
      );
    }
    return removed;
  };
  const startCleanup = (): RetainedOperation<boolean> => {
    if (retainedCleanup?.read().status === "pending") {
      return retainedCleanup;
    }
    if (!active) {
      const retained = createRetainedOperation<boolean>(() => {});
      retained.resolve(complete(true));
      return (retainedCleanup = retained.operation);
    }
    return (retainedCleanup = mapRetainedOperation(
      startRemoveTempDirectory(tempDir, reportFailure),
      complete,
    ));
  };
  return {
    location,
    cleanupRoot: tempDir,
    cleanup: () => {
      if (pending || retainedCleanup?.read().status === "pending") {
        // Pending async removal: return false without a false warning;
        // requireCleanup delegates to complete(false) for the fatal throw.
        return requireCleanup ? complete(false) : false;
      }
      if (!active) {
        return complete(true);
      }
      return complete(removeTempDirectory(tempDir, reportFailure));
    },
    cleanupAsync: () => {
      if (snapshotDirectories.get(tempDir)?.releaseRetained || retainedCleanup) {
        return startCleanup().result;
      }
      if (pending) {
        return pending;
      }
      if (!active) {
        return Promise.resolve(complete(true));
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
    startCleanup,
  };
}
