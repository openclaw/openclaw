import fs from "node:fs";
import path from "node:path";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import {
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
  retainSnapshotWork,
} from "../../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSync } from "../../infra/sqlite-snapshot-source.js";
import { createSqliteSnapshotStagingDirectory } from "../../infra/sqlite-snapshot-staging.js";
import {
  inspectDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import {
  acquireStateDatabaseHandleLease,
  captureStateDatabaseCoordinatorRuntime,
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseSourceExclusion,
} from "../../infra/state-database-coordinator.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { cronStoreKey } from "./key.js";
import { restoreCronLoadError } from "./load-error.js";
import type { CronReadOnlyRequest, CronReadOnlyResult } from "./read-only.types.js";
import type { LoadedCronStore } from "./types.js";

function emptyLoadedCronStore(): LoadedCronStore {
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

/** Loads cron jobs from existing SQLite state without creating or migrating it. */
export async function loadCronJobsStoreWithConfigJobsReadOnly(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return emptyLoadedCronStore();
  }
  const storeKey = cronStoreKey(storePath);
  const preserveArtifacts = isArtifactPreservingStateRead();
  const assertExcluded = hasStateDatabaseSourceExclusion(statePath)
    ? prepareStateDatabaseSourceExclusion(statePath)
    : undefined;
  const coordinatorRuntime = captureStateDatabaseCoordinatorRuntime();
  const admission = !assertExcluded
    ? captureOpenClawStateDatabaseReadAdmission(statePath)
    : undefined;
  const identity = admission?.identity ?? inspectDatabasePathIdentitySync(statePath);
  const canonicalPath = identity?.canonicalPath ?? path.resolve(statePath);
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  ensureSqliteLibrarySelected();
  const environment = { ...process.env };
  const environmentBytes = Object.entries(environment).reduce(
    (bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value ?? ""),
    0,
  );
  const pool = new WorkerTaskPool<CronReadOnlyRequest, CronReadOnlyResult>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("cronReadOnly"),
    workerOptions: { env: environment },
    maxWorkers: 1,
    sharedCompute: true,
  });
  const controller = new AbortController();
  const producerSettled = createDeferredCore();
  let sourcePin: ReturnType<typeof acquireStateDatabaseHandleLease> | undefined;
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  let stagingRoot: string | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let workerStopped = false;
  let cleaned = false;
  let cleanupPending: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleaned) {
      return Promise.resolve();
    }
    return (cleanupPending ??= (async () => {
      // A failed retirement keeps this exact pool and its pins available for canonical retry.
      if (!workerStopped) {
        await pool.close();
        workerStopped = true;
      }
      await producerSettled.promise;
      releaseSnapshot?.();
      releaseSnapshot = undefined;
      if (prepared) {
        if (!(await prepared.cleanupAsync())) {
          throw new Error("Cron read-only state snapshot cleanup failed.");
        }
        prepared = undefined;
      }
      if (stagingRoot) {
        if (!(await removeTempDirectoryAsync(stagingRoot))) {
          throw new Error("Cron read-only state snapshot cleanup failed.");
        }
        stagingRoot = undefined;
      }
      sourcePin?.release();
      sourcePin = undefined;
      cleaned = true;
      unregister();
    })().finally(() => {
      cleanupPending = undefined;
    }));
  };
  const resource = {
    async close(target?: DatabasePathIdentity) {
      if (!target || target.key === identity?.key || target.canonicalPath === canonicalPath) {
        controller.abort(new Error("Cron read-only load closed"));
        await cleanup();
      }
    },
  };
  const unregister = registerOpenClawStateDatabaseAsyncResource(resource);
  const run = async () => {
    let loaded = emptyLoadedCronStore();
    try {
      maintenance?.own(resource, "shared-resources", () => resource.close());
      // Only the native exclusion owner can prepare its already-drained source.
      sourcePin = assertExcluded
        ? acquireStateDatabaseHandleLease({ databasePath: statePath })
        : undefined;
      if (assertExcluded && preserveArtifacts) {
        prepared = prepareSqliteReadOnlyLocationSync(statePath);
        releaseSnapshot = retainSnapshotTempDirectory(
          prepared.cleanupRoot ?? path.dirname(prepared.location),
        );
      }
      if (preserveArtifacts && !assertExcluded) {
        stagingRoot = await createSqliteSnapshotStagingDirectory(
          undefined,
          false,
          controller.signal,
          true,
        );
        releaseSnapshot = retainSnapshotTempDirectory(stagingRoot);
      }
      const location = prepared?.location ?? statePath;
      controller.signal.throwIfAborted();
      assertExcluded?.();
      admission?.assertCurrent();
      const result = await pool.run(
        {
          location,
          storeKey,
          stagingRoot,
          coordinatorRuntime,
        },
        {
          signal: controller.signal,
          inputBytes:
            Buffer.byteLength(location) +
            Buffer.byteLength(storeKey) +
            Buffer.byteLength(stagingRoot ?? "") +
            Buffer.byteLength(coordinatorRuntime.directory) +
            environmentBytes,
        },
      );
      if (!result.ok) {
        throw restoreCronLoadError(result.error);
      }
      loaded = result.loaded ?? loaded;
    } finally {
      producerSettled.resolve();
      await cleanup();
    }
    controller.signal.throwIfAborted();
    assertExcluded?.();
    admission?.assertCurrent();
    return loaded;
  };
  return await retainSnapshotWork(run(), () =>
    controller.abort(new Error("Cron read-only load closed")),
  );
}
