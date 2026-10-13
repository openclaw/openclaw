import { AsyncLocalStorage } from "node:async_hooks";
// Select an owned snapshot or native reader while retaining snapshot cleanup.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { mapRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import {
  artifactPreservingReads,
  isArtifactPreservingStateRead,
} from "../state/artifact-preserving-state-reads.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareSqliteSnapshotFromLiveOwner } from "./sqlite-live-snapshot.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "./sqlite-readonly-location.types.js";
import {
  resolveSqliteInspectionSignal,
  captureSqliteReadOnlyWorkerLaunch,
  isSqliteInspectionDeadlineOwnedByCaller,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
} from "./sqlite-readonly-worker.js";
import {
  prepareSingleFlightSqliteSnapshot,
  startSingleFlightSqliteSnapshot,
} from "./sqlite-snapshot-single-flight.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";
import { readDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";
import { isUpdateRehearsalPrivateDatabase } from "./update-rehearsal-paths.js";

/** The inspection scope owns private readers until native close and snapshot disposal settle. */
export function openSqliteReadOnlyDatabase(
  pathname: string,
  options: Parameters<typeof openNodeSqliteDatabase>[1] = {},
) {
  const scope = artifactPreservingReads.getStore();
  if (!scope || !isArtifactPreservingStateRead("agent", pathname)) {
    return openNodeSqliteDatabase(pathname, { ...options, readOnly: true });
  }
  // The published updater already prepared this image. Keep inspection read-only
  // and scoped, but do not copy the same database again for each canary check.
  const snapshot = isUpdateRehearsalPrivateDatabase(pathname, process.env)
    ? undefined
    : prepareSqliteReadOnlyLocationSync(pathname);
  const release = snapshot
    ? retainSnapshotTempDirectory(snapshot.cleanupRoot ?? path.dirname(snapshot.location))
    : undefined;
  const native: { close?: () => void } = {};
  const close = () => {
    native.close?.();
    release?.();
    if (snapshot && !snapshot.cleanup()) {
      throw new SqliteSnapshotCleanupError("SQLite inspection snapshot cleanup failed.");
    }
    scope.readers.delete(close);
  };
  scope.readers.add(close);
  const db = openNodeSqliteDatabase(snapshot?.location ?? pathname, { ...options, readOnly: true });
  const dispose = db.close.bind(db);
  native.close = () => {
    if (db.isOpen) {
      dispose();
    }
  };
  db.close = close;
  return db;
}

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: {
    preserveSourceArtifacts?: boolean;
    signal?: AbortSignal;
    /** A dedicated reader pins its transaction without borrowing a live writer's connection. */
    allowLiveOwner?: boolean;
    /** Throw removal failures with their cause instead of warning; a caller signal implies it. */
    requireCleanup?: boolean;
  } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  const signal = resolveSqliteInspectionSignal(options.signal);
  const preserveSourceArtifacts =
    options.preserveSourceArtifacts === true || isArtifactPreservingStateRead("agent", pathname);
  try {
    signal?.throwIfAborted();
    if (!preserveSourceArtifacts && options.allowLiveOwner !== false) {
      const owned = prepareSqliteSnapshotFromLiveOwner(pathname, signal);
      if (owned) {
        return await owned;
      }
    }
    // The worker path preserves cleanup failures ahead of cancellation.
    return prepareWorkerSnapshot(pathname, { ...options, preserveSourceArtifacts }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

export function startSqliteReadOnlyLocationAsync(
  inputPathname: string,
  options: {
    preserveSourceArtifacts?: boolean;
    signal?: AbortSignal;
    expectedSourceIdentity?: DatabaseFileIdentity;
  } = {},
): RetainedSqliteSnapshotPreparation {
  const signal = resolveSqliteInspectionSignal(options.signal);
  signal?.throwIfAborted();
  const pathname = path.resolve(inputPathname);
  const preserveSourceArtifacts =
    options.preserveSourceArtifacts === true || isArtifactPreservingStateRead("agent", pathname);
  const expectedSourceIdentity =
    options.expectedSourceIdentity === undefined
      ? undefined
      : readDatabaseFileIdentity(options.expectedSourceIdentity);
  if (expectedSourceIdentity && !preserveSourceArtifacts) {
    throw new Error("SQLite source identity requires artifact-preserving preparation");
  }
  const requireCleanup = options.signal !== undefined;
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const root = resolvePrivateSqliteSnapshotStagingRoot();
  const deadlineOwnedByCaller = isSqliteInspectionDeadlineOwnedByCaller();
  const staging = captureSqliteSnapshotStagingOwner();
  const runInContext = AsyncLocalStorage.snapshot();
  return startSingleFlightSqliteSnapshot(
    pathname,
    `${preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${requireCleanup ? "strict" : "best-effort"}:async-token${expectedSourceIdentity ? `:${JSON.stringify(expectedSourceIdentity)}` : ""}`,
    (flightSignal) =>
      runInContext(() => {
        const task = staging.start(
          {
            type: "prepare",
            root,
            pathname,
            allowLegacyWorker: false,
            preserveSourceArtifacts,
            expectedSourceIdentity,
            deadlineOwnedByCaller,
            launch: { env, cwd, transport: { kind: "native" } },
          },
          flightSignal,
        );
        return {
          ...mapRetainedOperation(task, (reply) => {
            if (reply.type !== "prepared") {
              throw new Error(
                "SQLite snapshot producer returned an allocation without its prepared location",
              );
            }
            return adoptPreparedLocation(reply.location, reply.directory, requireCleanup);
          }),
          startClose: () => task.startClose(),
        };
      }),
    signal,
    { scope: staging },
  );
}

function prepareWorkerSnapshot(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal; requireCleanup?: boolean },
  signal: AbortSignal | undefined,
): Promise<PreparedSqliteReadOnlyLocation> {
  signal?.throwIfAborted();
  const requireCleanup = options.requireCleanup ?? options.signal !== undefined;
  return prepareSingleFlightSqliteSnapshot(
    pathname,
    `${options.preserveSourceArtifacts ? "worker-sync" : "worker-async"}:${requireCleanup ? "strict" : "best-effort"}:sync-token`,
    async (flightSignal, recordCleanupFailure) => {
      let stagingRoot: string | undefined;
      try {
        flightSignal.throwIfAborted();
        stagingRoot = await createSqliteSnapshotStagingDirectory(undefined, false, flightSignal);
        flightSignal.throwIfAborted();
        const location = await runSqliteReadOnlyWorker(pathname, {
          mode: options.preserveSourceArtifacts ? "sync" : "async",
          signal: flightSignal,
          stagingRoot,
        });
        flightSignal.throwIfAborted();
        return adoptPreparedLocation(location, stagingRoot, requireCleanup);
      } catch (error) {
        if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
          const failure = new SqliteSnapshotCleanupError(
            `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
            { cause: error },
          );
          recordCleanupFailure(failure);
          throw failure;
        }
        if (error instanceof SqliteSnapshotCleanupError) {
          recordCleanupFailure(error);
          throw error;
        }
        flightSignal.throwIfAborted();
        throw error;
      }
    },
    signal,
  );
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new SqliteSnapshotCleanupError(
        `${coerceErrorMessage(error)}; SQLite snapshot cleanup failed: ${stagingRoot}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    // SAFETY: lstatSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    return await operation(prepared ? prepared.location : pathname);
  } catch (error) {
    if (prepared) {
      throw error;
    }
    prepared = await prepareSqliteSnapshotSource(pathname);
    if (!prepared) {
      throw error;
    }
    return await operation(prepared.location);
  } finally {
    await prepared?.cleanupAsync();
  }
}

/** Fresh bytes without opening SQLite or making another durable private copy. */
export function readSqliteSourceContentVersionSync(pathname: string): string | undefined {
  // Raw descriptor closes stay in the child so the writer's native SQLite locks remain held.
  return runSqliteReadOnlyWorkerSync(pathname, undefined, "content-version") || undefined;
}
