// Synchronous readers retain inspection semantics without loading async snapshot staging.
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  artifactPreservingReads,
  isArtifactPreservingStateRead,
} from "../state/artifact-preserving-state-reads.js";
import { readCustodiedDrainedSqliteSource } from "../state/openclaw-state-maintenance-context.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { SqliteSnapshotCleanupError } from "./sqlite-lifecycle-errors.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  retainSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import {
  captureReusableSqliteSource,
  leaseReusableSqliteSnapshot,
  publishReusableSqliteSnapshot,
} from "./sqlite-snapshot-reuse.js";
import { createSqliteSnapshotStagingDirectorySync } from "./sqlite-snapshot-staging.js";
import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
  type DatabasePathIdentity,
} from "./sqlite-worker-identity.js";
import { isUpdateRehearsalPrivateDatabase } from "./update-rehearsal-paths.js";

type ArtifactReadScope = Exclude<
  ReturnType<typeof artifactPreservingReads.getStore>,
  false | undefined
>;

/** Aliases share a captured image only while they still name its physical source. */
export function findArtifactSnapshot(
  scope: ArtifactReadScope,
  sourceIdentity: DatabasePathIdentity,
) {
  const snapshot = scope.snapshots.get(sourceIdentity.canonicalPath);
  if (
    snapshot &&
    (snapshot.sourceIdentity.key !== sourceIdentity.key ||
      snapshot.sourceIdentity.birthtime !== sourceIdentity.birthtime)
  ) {
    throw new Error("SQLite database file identity changed during inspection");
  }
  return snapshot;
}

/** The inspection scope owns private readers until native close and snapshot disposal settle. */
export function retainArtifactSnapshot(
  scope: ArtifactReadScope,
  prepared: PreparedSqliteReadOnlyLocation,
  sourceIdentity: DatabasePathIdentity,
) {
  const releaseScope = retainSnapshotTempDirectory(
    prepared.cleanupRoot ?? path.dirname(prepared.location),
  );
  scope.privateRoots.add(prepared.cleanupRoot ?? path.dirname(prepared.location));
  const snapshot = {
    ...prepared,
    sourceIdentity,
    cleanup: () => {
      releaseScope();
      return prepared.cleanup();
    },
    cleanupAsync: () => {
      releaseScope();
      return prepared.cleanupAsync();
    },
  };
  scope.snapshots.set(sourceIdentity.canonicalPath, snapshot);
  return snapshot;
}

/** Borrow report-owned bytes through an awaited worker read; the report owns disposal. */
export function getArtifactPreservingSqliteRead(
  pathname: string,
): DatabasePathIdentity | undefined {
  const scope = artifactPreservingReads.getStore();
  if (!scope) {
    return undefined;
  }
  const sourceIdentity = readDatabasePathIdentitySync(pathname);
  const snapshot = findArtifactSnapshot(scope, sourceIdentity);
  if (!snapshot) {
    // The update driver already captured the entire disposable SQLite family.
    return isUpdateRehearsalPrivateDatabase(pathname, process.env) ? sourceIdentity : undefined;
  }
  return readDatabasePathIdentitySync(snapshot.location);
}

// Immutable reads cannot detect a writer, so a changed source invalidates what was read.
function assertCustodiedSourceUnchanged(pathname: string, before: BigIntStats): void {
  const after = fs.statSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (
    !after ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    readCustodiedDrainedSqliteSource(pathname) === undefined
  ) {
    throw new Error(`SQLite source changed during in-place inspection: ${pathname}`);
  }
}

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
  const sourceIdentity = readDatabasePathIdentitySync(pathname);
  let snapshot = findArtifactSnapshot(scope, sourceIdentity);
  const drained = snapshot
    ? undefined
    : readCustodiedDrainedSqliteSource(sourceIdentity.canonicalPath);
  if (!snapshot && !drained && !isUpdateRehearsalPrivateDatabase(pathname, process.env)) {
    const prepared = prepareSqliteReadOnlyLocationSync(pathname);
    snapshot = retainArtifactSnapshot(scope, prepared, sourceIdentity);
  }
  const release = snapshot
    ? retainSnapshotTempDirectory(snapshot.cleanupRoot ?? path.dirname(snapshot.location))
    : undefined;
  const native: { close?: () => void } = {};
  const close = () => {
    native.close?.();
    release?.();
    scope.readers.delete(close);
  };
  scope.readers.add(close);
  const location =
    snapshot?.location ??
    (drained ? resolveImmutableSqliteFileUri(sourceIdentity.canonicalPath) : pathname);
  const db = openNodeSqliteDatabase(location, { ...options, readOnly: true });
  const dispose = db.close.bind(db);
  native.close = () => {
    if (db.isOpen) {
      dispose();
      if (drained) {
        assertCustodiedSourceUnchanged(sourceIdentity.canonicalPath, drained);
      }
    }
  };
  db.close = close;
  return db;
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
  expectedSourceIdentity?: DatabaseFileIdentity,
  options: {
    /** Read-only consumers may borrow an unchanged artifact-preserving image. */
    reuse?: true;
  } = {},
): PreparedSqliteReadOnlyLocation {
  const lease = options.reuse
    ? leaseReusableSqliteSnapshot(pathname, expectedSourceIdentity)
    : undefined;
  if (lease) {
    return lease;
  }
  const source = options.reuse ? captureReusableSqliteSource(pathname) : undefined;
  const stagingRoot = createSqliteSnapshotStagingDirectorySync();
  try {
    const prepared = adoptPreparedLocation(
      runSqliteReadOnlyWorkerSync(pathname, stagingRoot, "sync", expectedSourceIdentity),
      stagingRoot,
    );
    return source
      ? publishReusableSqliteSnapshot(pathname, source, prepared, () => prepared.cleanup())
      : prepared;
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

/** Fresh bytes without opening SQLite or making another durable private copy. */
export function readSqliteSourceContentVersionSync(pathname: string): string | undefined {
  // Raw descriptor closes stay in the child so the writer's native SQLite locks remain held.
  return runSqliteReadOnlyWorkerSync(pathname, undefined, "content-version") || undefined;
}
