// Doctor owns preservation-first recovery of delivery metadata whose task no longer exists.
import { rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import {
  createPrivateSqliteTempDirectory,
  createPrivateSqliteTempDirectorySync,
} from "../infra/sqlite-private-directory.js";
import { withPreparedSqliteSnapshot } from "../infra/sqlite-readonly-location-cleanup.js";
import {
  resolveSqliteInspectionSignal,
  runSqliteReadOnlyWorker,
} from "../infra/sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "../infra/sqlite-snapshot-source.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  applyOrphanTaskDeliveryRecovery,
  assertKnownOrphanTaskDeliveryIntegrity,
  assertOrphanTaskDeliveryRecoveryShape,
  hasOrphanTaskDeliveryRows,
  preserveOrphanTaskDeliveryRecoveryInProcess,
} from "./openclaw-state-db-task-delivery-recovery-preservation.js";

function recoveryFailure(error: unknown, recoveryDirectory?: string): Error {
  return new Error(
    `Task delivery recovery failed without committing row removal${recoveryDirectory ? `; retained artifacts: ${recoveryDirectory}` : ""}: ${String(error)}`,
    { cause: error },
  );
}

/**
 * Synchronous SDK/native update-ledger callers retain their existing immediate transaction.
 * Foreign-key actions stay disabled; inbound dependents must fail the post-check, never cascade.
 */
export function recoverOrphanTaskDeliveryRows(database: DatabaseSync, pathname: string): string[] {
  if (!hasOrphanTaskDeliveryRows(database)) {
    return [];
  }
  assertOpenClawStateDatabaseOwner(database, { pathname });
  assertOrphanTaskDeliveryRecoveryShape(database);
  const count = assertKnownOrphanTaskDeliveryIntegrity(database);
  if (!database.isTransaction) {
    throw new Error("Orphan task delivery recovery requires the Doctor write transaction.");
  }
  // Copying source descriptors in another process preserves this native owner's POSIX locks.
  const prepared = prepareSqliteReadOnlyLocationSync(pathname);
  let recoveryDirectory: string | undefined;
  try {
    recoveryDirectory = createPrivateSqliteTempDirectorySync(
      path.dirname(pathname),
      "openclaw-task-delivery-recovery-",
    );
    const evidence = preserveOrphanTaskDeliveryRecoveryInProcess(
      prepared.location,
      pathname,
      recoveryDirectory,
    );
    if (evidence.count !== count) {
      throw new Error("Orphan task delivery snapshot changed before preservation.");
    }
    assertOpenClawStateDatabaseOwner(database, { pathname });
    return applyOrphanTaskDeliveryRecovery(database, pathname, evidence, recoveryDirectory);
  } catch (error) {
    throw recoveryFailure(error, recoveryDirectory);
  } finally {
    prepared.cleanup();
  }
}

/** Prepare evidence without a source write transaction; the caller's original fences remain held. */
export async function prepareOrphanTaskDeliveryRecovery(
  database: DatabaseSync,
  pathname: string,
): Promise<() => string[]> {
  if (!hasOrphanTaskDeliveryRows(database)) {
    return () => [];
  }
  assertOpenClawStateDatabaseOwner(database, { pathname });
  assertOrphanTaskDeliveryRecoveryShape(database);
  if (database.isTransaction) {
    throw new Error("Orphan task delivery preservation must precede the Doctor write transaction.");
  }
  const signal = resolveSqliteInspectionSignal();
  let recoveryDirectory: string | undefined;
  let preserved = false;
  try {
    const snapshot = await prepareSqliteReadOnlyLocation(pathname, {
      preserveSourceArtifacts: true,
      shared: false,
      signal,
    });
    const prepared = await withPreparedSqliteSnapshot(snapshot, async (snapshotPath) => {
      const directory = await createPrivateSqliteTempDirectory(
        path.dirname(pathname),
        "openclaw-task-delivery-recovery-",
      );
      recoveryDirectory = directory;
      const evidence = await runSqliteReadOnlyWorker(snapshotPath, {
        mode: "task-delivery-recovery",
        sourcePath: pathname,
        recoveryDirectory: directory,
        signal,
      });
      preserved = true;
      return { evidence, directory };
    });
    return () => {
      try {
        signal?.throwIfAborted();
        assertOpenClawStateDatabaseOwner(database, { pathname });
        return applyOrphanTaskDeliveryRecovery(
          database,
          pathname,
          prepared.evidence,
          prepared.directory,
        );
      } catch (error) {
        throw recoveryFailure(error, prepared.directory);
      }
    };
  } catch (error) {
    if (recoveryDirectory && !preserved) {
      try {
        await rm(recoveryDirectory, { recursive: true, force: true });
        recoveryDirectory = undefined;
      } catch (cleanupError) {
        throw createSqliteLifecycleAggregateError(
          [error, cleanupError],
          `Could not remove incomplete task delivery recovery: ${recoveryDirectory}`,
          error,
        );
      }
    }
    throw recoveryFailure(error, recoveryDirectory);
  }
}
