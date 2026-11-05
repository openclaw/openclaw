import { nativeProcessTestEntrypoints } from "../native-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import type { WorkerTaskPoolOptions } from "../worker-task-pool.types.js";

const workers = [
  {
    source: /\/backup-database-discovery\.worker\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.backupDatabaseDiscovery,
  },
  {
    source: /\/database-backup\.worker\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.databaseBackup,
  },
  {
    source: /\/update-candidate-state\.postgres\.worker\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.updatePostgresState,
  },
];

// Prepare the real workers before test deadlines instead of loading their source graph per task.
export function resolveBackupNativeWorkerTestOptions<Output>(
  options: WorkerTaskPoolOptions<Output>,
): WorkerTaskPoolOptions<Output> {
  const worker = workers.find(({ source }) => source.test(options.workerUrl.pathname));
  if (!worker) {
    return options;
  }
  return {
    ...options,
    workerUrl: resolveRuntimeWorkerUrl(worker.entrypoint),
    workerOptions: {
      ...options.workerOptions,
      // Prepared core workers still load plugin public APIs from this source host.
      execArgv:
        options.workerOptions?.execArgv ?? resolveRuntimeWorkerThreadExecArgv(options.workerUrl),
    },
  };
}
