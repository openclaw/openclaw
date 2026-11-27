import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import {
  formatSqliteReadOnlyInspectionFailure,
  isSqliteLockError,
  sqliteExtendedResultCode,
} from "./sqlite-error-diagnostics.js";
import {
  forkSqlitePrivateSnapshotInProcess,
  readSqlitePrivateSnapshotFamily,
} from "./sqlite-private-snapshot-fork.js";
import {
  releaseSnapshotTempDirectory,
  registerSnapshotTempDirectory,
  removeTempDirectoryAsync,
  cleanupSnapshotOperations,
  retireSqliteSnapshotPayload,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createOnlineReadOnlyBackup,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyCopyInProcess,
  SqliteSourceChangedError,
} from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  SQLITE_INSPECTION_CONTENTION_PREFIX,
  SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX,
  SQLITE_SNAPSHOT_CAPACITY_PREFIX,
  isSqliteSnapshotStagingMode,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";
import { isSqliteSnapshotCapacityError } from "./sqlite-snapshot-capacity-error.js";
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
import {
  createSqliteSnapshotStagingTokenSync,
  acquireSqliteSnapshotReadToken,
  reconcileSqliteSnapshotRetirement,
} from "./sqlite-snapshot-staging.js";
import type { SqliteStagingToken } from "./sqlite-staging-token.js";
import {
  assertExistingDatabaseIdentity,
  readDatabaseFileIdentity,
} from "./sqlite-worker-identity.js";

// Artifact-preserving sync requests must not open SQLite on the source. Live
// async backups pin committed pages with a read transaction and may update SHM.
export async function inspectSqliteReadOnlyLocation(
  args: string[],
  stagingTokens: Map<string, SqliteStagingToken>,
  retainPrepared: (prepared: PreparedSqliteReadOnlyLocation) => void,
): Promise<SqliteReadOnlyWorkerResult> {
  const mode = args[0];
  const pathname = args[1];
  const stagingRoot = args[2] || undefined;
  try {
    if (mode === "staging-sweep") {
      if (args.length !== 1) {
        throw new Error("SQLite staging sweep does not accept a database path");
      }
      const { reclaimSqliteSnapshotInstallationInProcess } =
        await import("./sqlite-snapshot-reclamation.js");
      return { ok: true, reclamation: await reclaimSqliteSnapshotInstallationInProcess() };
    }
    if (
      (mode !== "sync" &&
        mode !== "private-fork" &&
        mode !== "update-generation" &&
        mode !== "async" &&
        mode !== "staged-sync" &&
        mode !== "staged-async" &&
        mode !== "metadata" &&
        mode !== "backup-engine" &&
        mode !== "backup-engine-preserving" &&
        mode !== "state-sqlite-populated" &&
        mode !== "consolidated" &&
        mode !== "task-delivery-recovery" &&
        !isSqliteSnapshotStagingMode(mode)) ||
      !pathname
    ) {
      return {
        ok: false,
        message: "SQLite read-only worker requires a mode and a database path",
      };
    }
    if (mode === "state-sqlite-populated") {
      const [{ inspectPhysicalStoreInProcess }, { inspectStateSqlite }] = await Promise.all([
        import("./database-engine/physical-store-inspection.js"),
        import("../state/openclaw-state-db-engine.js"),
      ]);
      return {
        ok: true,
        hasExistingData: await inspectPhysicalStoreInProcess(pathname, true, (db) => {
          const facts = inspectStateSqlite(db);
          return !facts.hasEngineAnchor && facts.hasExistingData;
        }),
      };
    }
    if (mode === "backup-engine" || mode === "backup-engine-preserving") {
      const { readBackupEngineInProcess } =
        await import("./database-engine/physical-store-inspection.js");
      return {
        ok: true,
        engine: await readBackupEngineInProcess(pathname, mode === "backup-engine-preserving"),
      };
    }
    if (mode === "task-delivery-recovery") {
      const recoveryDirectory = args[2];
      const sourcePath = args[3];
      if (args.length !== 4 || !recoveryDirectory || !sourcePath) {
        throw new Error(
          "Task delivery recovery requires its private snapshot, recovery directory, and source path",
        );
      }
      const { preserveOrphanTaskDeliveryRecoveryInProcess } =
        await import("../state/openclaw-state-db-task-delivery-recovery-preservation.js");
      return {
        ok: true,
        taskDeliveryRecovery: preserveOrphanTaskDeliveryRecoveryInProcess(
          pathname,
          sourcePath,
          recoveryDirectory,
        ),
      };
    }
    if (
      args.length > 4 ||
      (args[3] !== undefined &&
        mode !== "sync" &&
        mode !== "staged-sync" &&
        mode !== "metadata" &&
        mode !== "private-fork")
    ) {
      throw new Error("SQLite source identity is supported only for sync or metadata snapshots");
    }
    const expectedSourceIdentity =
      args[3] === undefined || mode === "private-fork"
        ? undefined
        : readDatabaseFileIdentity(JSON.parse(args[3]));
    const staged = mode === "staged-sync" || mode === "staged-async";
    if (staged && !stagingRoot) {
      throw new Error("SQLite staged snapshot requires its owner-allocated directory");
    }
    if (mode === "update-generation") {
      const { readUpdateDatabaseGenerations } = await import("./update-database-generations.js");
      return {
        ok: true,
        generation: JSON.stringify(readUpdateDatabaseGenerations([pathname])[pathname]),
      };
    }
    if (mode === "staging-reconcile") {
      reconcileSqliteSnapshotRetirement(pathname);
      return { ok: true, location: pathname };
    }
    if (mode === "staging-create" || mode === "staging-create-legacy") {
      const owned = createSqliteSnapshotStagingTokenSync(
        pathname,
        mode === "staging-create-legacy",
      );
      stagingTokens.set(owned.directory, owned.release);
      return { ok: true, location: owned.directory };
    }
    if (mode === "staging-retire") {
      const token = stagingTokens.get(pathname);
      if (!token) {
        throw new Error("SQLite snapshot token is not owned by this worker");
      }
      const retirement = beginSqliteSnapshotRetirement(pathname, { token });
      try {
        for (const _ of retireSqliteSnapshotPayload(retirement)) {
          await setImmediate();
        }
        stagingTokens.delete(pathname);
      } finally {
        retirement.release();
      }
      return { ok: true, location: pathname };
    }
    let prepared: PreparedSqliteReadOnlyLocation;
    if (mode === "private-fork") {
      if (!stagingRoot || args[3] === undefined) {
        throw new Error("SQLite private fork requires staging and its captured family");
      }
      prepared = await forkSqlitePrivateSnapshotInProcess(
        pathname,
        readSqlitePrivateSnapshotFamily(JSON.parse(args[3])),
        stagingRoot,
      );
    } else if (mode === "consolidated") {
      if (!stagingRoot || path.dirname(path.resolve(pathname)) !== path.resolve(stagingRoot)) {
        throw new Error(
          "SQLite consolidation requires its caller-owned private snapshot directory",
        );
      }
      // The backup owner admits a child staging token before reading the private
      // WAL family. Parent loss cannot let reclamation race its native backup.
      prepared = await createOnlineReadOnlyBackup(pathname, stagingRoot);
    } else if (mode === "metadata") {
      if (!expectedSourceIdentity) {
        throw new Error("SQLite metadata snapshot requires a captured source identity");
      }
      const [{ assertStateDatabaseAccessAllowed }, { hasVerifiedLiveSqliteOwner }] =
        await Promise.all([import("./gateway-state-owner.js"), import("./sqlite-live-owner.js")]);
      assertExistingDatabaseIdentity(
        pathname,
        expectedSourceIdentity.key,
        expectedSourceIdentity.birthtime,
      );
      assertStateDatabaseAccessAllowed(pathname);
      const liveOwner = hasVerifiedLiveSqliteOwner(pathname);
      prepared = liveOwner
        ? await createOnlineReadOnlyBackup(pathname, stagingRoot)
        : await prepareSqliteReadOnlyCopyInProcess(pathname, stagingRoot, expectedSourceIdentity);
      try {
        assertExistingDatabaseIdentity(
          pathname,
          expectedSourceIdentity.key,
          expectedSourceIdentity.birthtime,
        );
        assertStateDatabaseAccessAllowed(pathname);
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    } else {
      const destination = staged && stagingRoot ? { directory: stagingRoot } : stagingRoot;
      prepared =
        mode === "sync" || mode === "staged-sync"
          ? await prepareSqliteReadOnlyCopyInProcess(pathname, destination, expectedSourceIdentity)
          : await prepareSqliteReadOnlyLocationInProcess(pathname, destination);
    }
    const directory = prepared.cleanupRoot ?? path.dirname(prepared.location);
    // Delivery can precede its callback: the caller must be able to retire immediately.
    // Keep cleanup custody, but release the producer's native lock before publication.
    releaseSnapshotTempDirectory(directory);
    registerSnapshotTempDirectory(directory);
    retainPrepared(prepared);
    return { ok: true, location: prepared.location };
  } catch (error) {
    const contention = error instanceof SqliteSourceChangedError || isSqliteLockError(error);
    const allocationRefused =
      (mode === "staging-create" || mode === "staging-create-legacy") &&
      isPrivateDirectoryCreationRefused(error);
    const prefix =
      (isSqliteSnapshotCapacityError(error) ? SQLITE_SNAPSHOT_CAPACITY_PREFIX : "") +
      (contention ? SQLITE_INSPECTION_CONTENTION_PREFIX : "") +
      (allocationRefused ? SQLITE_SNAPSHOT_ALLOCATION_REFUSED_PREFIX : "");
    // Engine probes moved native reads into this child; callers still classify corruption.
    // Released snapshot modes retain their exact { ok, message } response shape.
    const errcode =
      mode === "backup-engine" ||
      mode === "backup-engine-preserving" ||
      mode === "state-sqlite-populated"
        ? sqliteExtendedResultCode(error)
        : undefined;
    return {
      ok: false,
      message: `${prefix}${formatSqliteReadOnlyInspectionFailure(error)}`,
      ...(errcode === undefined ? {} : { errcode }),
    };
  }
}

export async function runSqliteReadOnlyInspection(args: string[]): Promise<void> {
  const staged = args[0] === "staged-sync" || args[0] === "staged-async";
  const directory = staged ? args[2] : undefined;
  let prepared: PreparedSqliteReadOnlyLocation | undefined;
  let delivered = false;
  try {
    // The independent token child must not retire a surviving copy's destination.
    const release = directory ? acquireSqliteSnapshotReadToken(directory) : undefined;
    let result: SqliteReadOnlyWorkerResult;
    try {
      result = await inspectSqliteReadOnlyLocation(args, new Map(), (snapshot) => {
        prepared = snapshot;
      });
    } finally {
      release?.();
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(result), (error) => (error ? reject(error) : resolve()));
    });
    delivered = true;
    if (prepared) {
      releaseSnapshotTempDirectory(prepared.cleanupRoot ?? path.dirname(prepared.location));
    }
  } finally {
    if (!delivered) {
      await cleanupSnapshotOperations();
      if (directory) {
        await removeTempDirectoryAsync(directory);
      }
    }
  }
}
