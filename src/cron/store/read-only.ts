import fs from "node:fs";
import { ensureSqliteLibrarySelected } from "../../infra/bun-sqlite-library.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import {
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
  retainSnapshotTempDirectory,
  retainSnapshotWork,
} from "../../infra/sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "../../infra/sqlite-snapshot-staging.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { getChildLogger } from "../../logging/logger.js";
import type { PluginDoctorCronJob } from "../../plugins/doctor-contract-module.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseAsyncResource,
} from "../../state/openclaw-state-db-cache.js";
import { isStatePostgres } from "../../state/openclaw-state-db-engine.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { restoreCronLoadError } from "./load-error.js";
import { resolveCronStoreKeyAsync } from "./paths.js";
import type {
  CronOwnerInspectionRow,
  CronReadOnlyRequest,
  CronReadOnlyResult,
  CronRunHistoryCandidates,
  CronRunHistoryBinding,
  CronRunHistorySelector,
} from "./read-only.types.js";
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

/** Loads cron jobs from existing state without creating or migrating it. */
export async function loadCronJobsStoreWithConfigJobsReadOnly(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  const context = captureOpenClawStateWorkerContext({ env });
  const storeKey = await resolveCronStoreKeyAsync(storePath, env, context);
  return loadCronJobsStoreWithConfigJobsReadOnlyByKey(storeKey, env);
}

/** Reads a captured opaque partition without applying public pathname selection again. */
export async function loadCronJobsStoreWithConfigJobsReadOnlyByKey(
  storeKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  return (await readCronState({ storeKey, env })).loaded ?? emptyLoadedCronStore();
}

/** PostgreSQL state is read in the cron worker, never on the Gateway thread. */
export async function readCronJobOwnerRowsReadOnly(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CronOwnerInspectionRow[]> {
  const context = captureOpenClawStateWorkerContext({ env });
  const storeKey = await resolveCronStoreKeyAsync(storePath, env, context);
  return (await readCronState({ storeKey, env, inspect: "owners" })).owners ?? [];
}

export async function assertCronStateReadSchemaReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await readCronState({ env, inspect: "schema" });
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
  inspect,
}: {
  storeKey?: string;
  env: NodeJS.ProcessEnv;
  history?: CronReadOnlyRequest["history"];
  inspect?: CronReadOnlyRequest["inspect"];
}): Promise<Extract<CronReadOnlyResult, { ok: true }>> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return { ok: true };
  }
  // Doctor's all-partition inventory must not create WAL/SHM files beside the source.
  const preserveArtifacts =
    !isStatePostgres() && (storeKey === undefined || isArtifactPreservingStateRead());
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
    workerClass: "singleton",
    sharedCompute: true,
  });
  const controller = new AbortController();
  const producerSettled = createDeferredCore();
  let stagingRoot: string | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let workerStopped = false;
  let readSucceeded = false;
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
        let cause: unknown;
        if (!(await removeTempDirectoryAsync(stagingRoot, (error) => (cause = error)))) {
          const error = new SqliteSnapshotCleanupError(
            "Cron read-only state snapshot cleanup failed.",
            { cause },
          );
          if (!readSucceeded) {
            throw error;
          }
          // All readers are retired; the disposable directory remains registered for retry.
          // Failed removal must not replace the successful inventory with a repair failure.
          try {
            getChildLogger({ subsystem: "cron" }).warn(
              { path: stagingRoot, error: String(cause) },
              "Cron read-only snapshot cleanup deferred; the read completed successfully.",
            );
          } catch {
            // Diagnostic failure cannot change the read's outcome.
          }
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
    const failures: unknown[] = [];
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
          inspect,
        },
        {
          signal: controller.signal,
          inputBytes:
            Buffer.byteLength(location) +
            Buffer.byteLength(storeKey ?? "") +
            Buffer.byteLength(history?.jobId ?? "") +
            Buffer.byteLength(history?.query ?? "") +
            Buffer.byteLength(JSON.stringify(history?.jobNameById ?? {})) +
            (history?.taskIds?.reduce((bytes, id) => bytes + Buffer.byteLength(id), 0) ?? 0) +
            Buffer.byteLength(history?.transcript?.runId ?? "") +
            (history?.transcript?.runAtMs === undefined ? 0 : 8) +
            Buffer.byteLength(stagingRoot ?? "") +
            Buffer.byteLength(inspect ?? "") +
            environmentBytes,
        },
      );
      if (!result.ok) {
        throw restoreCronLoadError(result.error);
      }
      loaded = result;
      readSucceeded = true;
    } catch (error) {
      failures.push(error);
    } finally {
      producerSettled.resolve();
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    throwSqliteLifecycleErrors(failures, "Cron read-only state inspection and cleanup failed.");
    controller.signal.throwIfAborted();
    admission.assertCurrent();
    return loaded;
  };
  return await retainSnapshotWork(run(), () =>
    controller.abort(new Error("Cron read-only load closed")),
  );
}

export async function readCronRunHistoryCandidates(
  storeKey: string,
  jobId?: string,
  query?: string,
  jobNameById?: Record<string, string>,
): Promise<CronRunHistoryCandidates> {
  return (
    (
      await readCronState({
        storeKey,
        env: process.env,
        history: { jobId, query, jobNameById },
      })
    ).candidates ?? { records: [] }
  );
}

export async function readCronRunHistoryRecords(
  storeKey: string,
  taskIds: string[],
  view?: "full" | "summary",
): Promise<CronRunRecord[]> {
  if (taskIds.length === 0) {
    return [];
  }
  return (
    (
      await readCronState({
        storeKey,
        env: process.env,
        history: { taskIds, view },
      })
    ).history ?? []
  );
}

export async function readCronRunHistoryBinding(
  storeKey: string,
  jobId: string,
  transcript: CronRunHistorySelector,
): Promise<CronRunHistoryBinding | undefined> {
  return (
    await readCronState({
      storeKey,
      env: process.env,
      history: { jobId, transcript },
    })
  ).binding;
}
