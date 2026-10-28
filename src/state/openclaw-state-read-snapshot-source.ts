import path from "node:path";
import { sleepWithAbort } from "@openclaw/retry";
import { mapRetainedOperation, type RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import {
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-record.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { formatSqliteReadOnlyInspectionFailure } from "../infra/sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { captureSqlitePrivateSnapshotFamily } from "../infra/sqlite-private-snapshot-fork.js";
import {
  deferSqliteSnapshotCleanupAfterRead,
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "../infra/sqlite-readonly-location.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
  SqlitePrivateSnapshotFamily,
} from "../infra/sqlite-readonly-location.types.js";
import {
  readSqliteInspectionBudget,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import {
  forkSqlitePrivateSnapshot,
  prepareSqliteReadOnlyLocation,
  startSqliteReadOnlyLocationAsync,
} from "../infra/sqlite-snapshot-source.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerMayCopySourcesInProcess,
} from "./openclaw-state-maintenance-context.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

const log = createSubsystemLogger("state/db");

export type StateReadSnapshotSource = {
  location: string;
  cleanupRoot?: string;
  cleanClose?: boolean;
  postgresSnapshot?: string;
};

/** Own physical snapshot preparation until the enclosing read scope drains its readers. */
export async function prepareOpenClawStateReadSnapshotSource({
  pathname,
  env,
  postgres,
  lazy,
  controller,
  callerSignal,
  admissionTimeoutMs,
  reuseCleanClose,
}: {
  pathname: string;
  env: NodeJS.ProcessEnv;
  postgres: boolean;
  lazy: boolean;
  controller: AbortController;
  callerSignal?: AbortSignal;
  admissionTimeoutMs?: number;
  reuseCleanClose?: boolean;
}) {
  const admissionSignal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const artifactPreserving = isArtifactPreservingStateRead();
  const assertHostAdmission = () =>
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  let admission: ReturnType<typeof captureOpenClawStateDatabaseReadAdmission> | undefined;
  let prepared: AsyncPreparedSqliteReadOnlyLocation | undefined;
  let source: StateReadSnapshotSource | undefined;
  let family: SqlitePrivateSnapshotFamily | undefined;
  let cleanClose = false;
  let postgresSnapshot: string | undefined;
  let releaseSource: (() => void) | undefined;
  let preparation: RetainedSqliteSnapshotPreparation | undefined;
  let materialization: RetainedOperation<AsyncPreparedSqliteReadOnlyLocation> | undefined;
  let budget: ReturnType<typeof readSqliteInspectionBudget> | undefined;
  let deadline = Infinity;
  const retainSource = (location: AsyncPreparedSqliteReadOnlyLocation) => {
    prepared = location;
    family = location.privateFamily;
    // Callers key prepared reads and discovery caches by this scope's source identity.
    source = {
      location: location.location,
      cleanupRoot: location.cleanupRoot,
      cleanClose,
      postgresSnapshot,
    };
    releaseSource =
      postgres || cleanClose
        ? undefined
        : retainSnapshotTempDirectory(location.cleanupRoot ?? path.dirname(location.location));
  };
  const capture = () => {
    admissionSignal.throwIfAborted();
    assertHostAdmission();
    return captureOpenClawStateDatabaseReadAdmission(pathname);
  };
  const startLazySource = () => {
    if (!materialization && !prepared && existingPathOrUndefined(pathname)) {
      const captured = capture();
      admission = captured;
      budget = readSqliteInspectionBudget("read-only snapshot", pathname);
      deadline = performance.now() + budget.timeoutMs;
      const preserveSourceArtifacts = artifactPreserving || isArtifactPreservingStateRead();
      preparation = startSqliteReadOnlyLocationAsync(pathname, {
        preserveSourceArtifacts,
        signal: admissionSignal,
        expectedSourceIdentity: preserveSourceArtifacts ? captured.identity : undefined,
      });
      // Sync readers must publish the same source without waiting for a Promise reaction.
      materialization = mapRetainedOperation(preparation, (location) => {
        retainSource(location);
        admissionSignal.throwIfAborted();
        assertHostAdmission();
        captured.assertCurrent();
        return location;
      });
    }
    return materialization;
  };
  if (!lazy) {
    const admissionDeadline = performance.now() + (admissionTimeoutMs ?? 0);
    let nextWaitLog = 0;
    try {
      // Wait only before capturing private bytes; callbacks and cleanup must never replay.
      admission = await acquireWithWait({
        acquire: capture,
        shouldRetry: (error) => {
          if (
            !(error instanceof StateDatabaseAdmissionPendingError) &&
            !(error instanceof StateDatabaseOfflineMaintenanceError)
          ) {
            return false;
          }
          if (error.databasePath !== pathname) {
            return false;
          }
          const now = performance.now();
          if (now >= nextWaitLog && now < admissionDeadline) {
            log.warn(
              `Waiting for shared-state admission (up to ${Math.ceil((admissionDeadline - now) / 1000)} s remaining). ${error.message}`,
            );
            nextWaitLog = now + 30_000;
          }
          return true;
        },
        deadlineMs: admissionDeadline,
        pollIntervalMs: 250,
        sleep: (ms) => sleepWithAbort(ms, admissionSignal),
      });
      admissionSignal.throwIfAborted();
      if (nextWaitLog > 0) {
        log.info(`Shared-state admission acquired: ${pathname}`);
      }
      cleanClose = !postgres && reuseCleanClose === true && readSqliteDatabaseCleanClose(pathname);
      if (postgres) {
        const { openPostgresStateReadSnapshot } =
          await import("./openclaw-state-postgres-snapshot.js");
        const retained = await openPostgresStateReadSnapshot(
          captureOpenClawStateReadWorkerContext({ path: pathname, env }),
          admissionSignal,
        );
        postgresSnapshot = retained.snapshot;
        prepared = {
          location: pathname,
          cleanupAsync: () => retained.close().then(() => true),
        };
      } else if (cleanClose) {
        prepared = { location: pathname, cleanupAsync: async () => true };
      } else if (
        artifactPreserving &&
        maintenanceOwnerMayCopySourcesInProcess(getOpenClawDatabaseMaintenanceScope(), pathname) &&
        !openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(pathname)
      ) {
        prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
        if (prepared.cleanupRoot) {
          prepared.privateFamily = captureSqlitePrivateSnapshotFamily(
            prepared.location,
            prepared.cleanupRoot,
          );
        }
      } else if (artifactPreserving) {
        // Share only the retained read producer, never a generic mutable snapshot lease.
        preparation = startSqliteReadOnlyLocationAsync(pathname, {
          preserveSourceArtifacts: true,
          signal: admissionSignal,
          expectedSourceIdentity: admission.identity,
        });
        prepared = await preparation.result;
      } else {
        prepared = await prepareSqliteReadOnlyLocation(pathname, {
          preserveSourceArtifacts: artifactPreserving,
          signal: controller.signal,
        });
      }
      retainSource(prepared);
    } catch (error) {
      if (nextWaitLog > 0) {
        log.warn(`Shared-state admission wait ended without a snapshot. ${String(error)}`);
      }
      try {
        releaseSource?.();
        if (preparation) {
          // A rejected retained producer still owns its child and unpublished directory.
          await preparation.startClose().result;
        } else if (prepared && !(await prepared.cleanupAsync())) {
          throw new SqliteSnapshotCleanupError("Shared-state snapshot preparation cleanup failed");
        }
      } catch (cleanupError) {
        throw createSqliteLifecycleAggregateError(
          [error, cleanupError],
          "Shared-state snapshot preparation and cleanup failed",
          error,
        );
      }
      const retry =
        error instanceof StateDatabaseAdmissionPendingError ||
        error instanceof StateDatabaseOfflineMaintenanceError
          ? "Retry after the current state operation completes. "
          : "";
      throw new Error(
        `Cannot read shared state for discovery: ${pathname}. ${retry}${formatSqliteReadOnlyInspectionFailure(error)}`,
        { cause: error },
      );
    }
  }
  return {
    identity: () => admission?.identity,
    postgresSnapshot,
    assertCurrent() {
      if (admission) {
        assertHostAdmission();
        admission.assertCurrent();
      }
    },
    readSource: (): StateReadSnapshotSource | undefined => {
      if (lazy) {
        const pending = startLazySource();
        if (pending) {
          const pause = new Int32Array(new SharedArrayBuffer(4));
          for (;;) {
            pending.service();
            const outcome = pending.read();
            if (outcome.status === "rejected") {
              throw outcome.error;
            }
            if (outcome.status === "fulfilled") {
              break;
            }
            if (budget && performance.now() >= deadline) {
              controller.abort(
                sqliteInspectionTimeoutError(
                  "read-only snapshot",
                  pathname,
                  budget.timeoutMs,
                  budget.size,
                ),
              );
              controller.signal.throwIfAborted();
            }
            Atomics.wait(pause, 0, 0, 2);
          }
        }
      }
      return source;
    },
    prepareSource: lazy
      ? async () => {
          await startLazySource()?.result;
        }
      : undefined,
    forkSource: async (signal?: AbortSignal) => {
      const forkSignal = signal ? AbortSignal.any([signal, admissionSignal]) : admissionSignal;
      forkSignal.throwIfAborted();
      // Join an accepted capture, but do not force unused lazy reports to acquire bytes.
      await materialization?.result;
      forkSignal.throwIfAborted();
      if (!prepared || !family) {
        return undefined;
      }
      const assertCurrent = () => {
        assertHostAdmission();
        admission?.assertCurrent();
      };
      assertCurrent();
      return forkSqlitePrivateSnapshot(prepared.location, family, forkSignal, assertCurrent);
    },
    async cleanup(readSucceeded: boolean) {
      releaseSource?.();
      if (!prepared) {
        await preparation?.startClose().result;
        return;
      }
      let cause: unknown;
      try {
        if (await prepared.cleanupAsync()) {
          await preparation?.startClose().result;
          return;
        }
      } catch (error) {
        if (readSucceeded && deferSqliteSnapshotCleanupAfterRead(error, prepared.cleanupRoot)) {
          return;
        }
        cause = error;
      }
      throw new SqliteSnapshotCleanupError(
        `Shared-state discovery snapshot cleanup failed: ${prepared.cleanupRoot ?? pathname}`,
        { cause },
      );
    },
  };
}
