import fs from "node:fs";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import {
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
  retainSnapshotWork,
} from "../../infra/sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "../../infra/sqlite-snapshot-staging.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { PluginDoctorCronJob } from "../../plugins/doctor-contract-module.js";
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
import type { CronRunRecord } from "./run-history.types.js";
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
  return (
    (await readCronState({ storeKey: cronStoreKey(storePath), env })).loaded ??
    emptyLoadedCronStore()
  );
}

/** Doctor inventory includes raw definitions in every persisted partition. */
export async function inspectCronJobsReadOnly(
  env: NodeJS.ProcessEnv,
): Promise<PluginDoctorCronJob[]> {
  return (await readCronState({ env })).inventory ?? [];
}

async function readCronState({
  storeKey,
  env,
  history,
}: {
  storeKey?: string;
  env: NodeJS.ProcessEnv;
  history?: { jobId?: string };
}): Promise<Extract<CronReadOnlyResult, { ok: true }>> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return { ok: true };
  }
  // Doctor's all-partition inventory must not create WAL/SHM files beside the source.
  const preserveArtifacts = storeKey === undefined || isArtifactPreservingStateRead();
  const admission = captureOpenClawStateDatabaseReadAdmission(statePath);
  const identity = admission.identity;
  const canonicalPath = identity.canonicalPath;
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
      if (stagingRoot) {
        if (!(await removeTempDirectoryAsync(stagingRoot))) {
          throw new Error("Cron read-only state snapshot cleanup failed.");
        }
        stagingRoot = undefined;
      }
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
    let loaded: Extract<CronReadOnlyResult, { ok: true }> = { ok: true };
    try {
      maintenance?.own(resource, "shared-resources", () => resource.close());
      if (preserveArtifacts) {
        stagingRoot = await createSqliteSnapshotStagingDirectory(
          undefined,
          false,
          controller.signal,
          true,
        );
        releaseSnapshot = retainSnapshotTempDirectory(stagingRoot);
      }
      const location = statePath;
      controller.signal.throwIfAborted();
      admission.assertCurrent();
      const result = await pool.run(
        {
          location,
          storeKey,
          history,
          stagingRoot,
        },
        {
          signal: controller.signal,
          inputBytes:
            Buffer.byteLength(location) +
            Buffer.byteLength(storeKey ?? "") +
            Buffer.byteLength(history?.jobId ?? "") +
            Buffer.byteLength(stagingRoot ?? "") +
            environmentBytes,
        },
      );
      if (!result.ok) {
        throw restoreCronLoadError(result.error);
      }
      loaded = result;
    } finally {
      producerSettled.resolve();
      await cleanup();
    }
    controller.signal.throwIfAborted();
    admission.assertCurrent();
    return loaded;
  };
  return await retainSnapshotWork(run(), () =>
    controller.abort(new Error("Cron read-only load closed")),
  );
}

export async function readCronRunRecords(
  storeKey: string,
  jobId?: string,
): Promise<CronRunRecord[]> {
  return (
    (
      await readCronState({
        storeKey: cronStoreKey(storeKey),
        env: process.env,
        history: { jobId },
      })
    ).history ?? []
  );
}
