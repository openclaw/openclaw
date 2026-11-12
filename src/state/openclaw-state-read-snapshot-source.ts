import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sleepWithAbort } from "@openclaw/retry";
import { mapRetainedOperation, type RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import {
  sameFileMutationFingerprint,
  type FileMutationFingerprint,
} from "../infra/file-descriptor.js";
import {
  StateDatabaseAdmissionPendingError,
  StateDatabaseOfflineMaintenanceError,
} from "../infra/gateway-state-owner-record.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteSnapshotCleanupError,
} from "../infra/sqlite-lifecycle-errors.js";
import {
  deferSqliteSnapshotCleanupAfterRead,
  retainSnapshotTempDirectory,
} from "../infra/sqlite-readonly-location-cleanup.js";
import type {
  AsyncPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
  SqlitePrivateSnapshotFamily,
} from "../infra/sqlite-readonly-location.types.js";
import {
  readSqliteInspectionBudget,
  runSqliteReadOnlyOperation,
  sqliteInspectionTimeoutError,
} from "../infra/sqlite-readonly-worker.js";
import { isSqliteSnapshotReuseActive } from "../infra/sqlite-snapshot-reuse.js";
import {
  forkSqlitePrivateSnapshot,
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationAwaited,
  startSqliteReadOnlyLocationAsync,
} from "../infra/sqlite-snapshot-source.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";
import { recoverOpenClawStateRollbackJournal } from "./openclaw-state-ownership.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";

const log = createSubsystemLogger("state/db");

export type StateReadSnapshotSource = {
  location: string;
  cleanupRoot?: string;
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
  allowStartupRollbackRecovery,
  live,
}: {
  pathname: string;
  env: NodeJS.ProcessEnv;
  postgres: boolean;
  lazy: boolean;
  controller: AbortController;
  callerSignal?: AbortSignal;
  admissionTimeoutMs?: number;
  allowStartupRollbackRecovery: boolean;
  live: boolean;
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
  let postgresSnapshot: string | undefined;
  let releaseSource: (() => void) | undefined;
  let rollbackSource: { path: string; fingerprint: FileMutationFingerprint }[] | undefined;
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
      postgresSnapshot,
    };
    releaseSource =
      postgres || location.location === pathname
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
        reuse: true,
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
      } else if (live) {
        const rollbackRecovery =
          allowStartupRollbackRecovery &&
          existsSync(`${pathname}-journal`) &&
          (await runSqliteReadOnlyOperation(
            pathname,
            { type: "startupMetadata.rollbackRecoveryRequired", input: undefined },
            {
              source: "canonical",
              expectedIdentity: admission.identity.key,
              env,
              signal: admissionSignal,
            },
          ));
        admission.assertCurrent();
        if (rollbackRecovery) {
          rollbackSource = [pathname, `${pathname}-journal`].map((filePath) => ({
            path: filePath,
            fingerprint: statSync(filePath, { bigint: true }),
          }));
          // Crash recovery on DELETE-journal filesystems writes before ownership checks; inspect a copy first.
          preparation = startSqliteReadOnlyLocationAsync(pathname, {
            preserveSourceArtifacts: true,
            signal: admissionSignal,
            expectedSourceIdentity: admission.identity,
          });
          prepared = await preparation.result;
          log.info("Startup state inspection selected private hot rollback-journal recovery", {
            path: pathname,
          });
        } else {
          prepared = { location: pathname, cleanupAsync: async () => true };
        }
      } else if (artifactPreserving && isSqliteSnapshotReuseActive()) {
        prepared = await prepareSqliteReadOnlyLocationAwaited(pathname, {
          signal: admissionSignal,
          expectedSourceIdentity: admission.identity,
          reuse: true,
        });
        // A borrowed image settles at once, so cancellation has not been observed yet.
        admissionSignal.throwIfAborted();
      } else if (artifactPreserving) {
        // Share only the retained read producer, never a generic mutable snapshot lease.
        preparation = startSqliteReadOnlyLocationAsync(pathname, {
          preserveSourceArtifacts: true,
          signal: admissionSignal,
          expectedSourceIdentity: admission.identity,
          reuse: true,
        });
        prepared = await preparation.result;
        // A borrowed image settles at once, so cancellation has not been observed yet.
        admissionSignal.throwIfAborted();
      } else {
        prepared = await prepareSqliteReadOnlyLocation(pathname, {
          preserveSourceArtifacts: artifactPreserving,
          signal: admissionSignal,
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
      throw new Error(
        `Cannot read shared state for discovery: ${pathname}. Retry after the current state operation completes. ${String(error)}`,
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
    recoverRollbackJournal: () => {
      const recoverySource = rollbackSource;
      if (!recoverySource || !prepared) {
        return;
      }
      recoverOpenClawStateRollbackJournal(pathname, prepared.location, env, () => {
        admissionSignal.throwIfAborted();
        assertHostAdmission();
        admission?.assertCurrent();
        // The private ownership verdict belongs only to this unchanged crashed source.
        for (const file of recoverySource) {
          if (
            !sameFileMutationFingerprint(file.fingerprint, statSync(file.path, { bigint: true }))
          ) {
            throw new Error(
              "Hot rollback-journal source changed during startup admission; retry startup.",
            );
          }
        }
      });
      rollbackSource = undefined;
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
