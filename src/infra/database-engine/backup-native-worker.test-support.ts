import { nativeProcessTestEntrypoints } from "../native-process-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";

const workers = [
  {
    source: /\/backup-database-discovery\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.backupDatabaseDiscovery,
  },
  {
    source: /\/database-backup\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.databaseBackup,
  },
  {
    source: /\/update-candidate-state\.postgres\.[jt]s$/,
    entrypoint: nativeProcessTestEntrypoints.updatePostgresState,
  },
];

// Prepare the real workers before test deadlines instead of loading their source graph per task.
export function resolveBackupNativeWorkerTestUrl(workerUrl: URL): URL {
  const worker = workers.find(({ source }) => source.test(workerUrl.pathname));
  return worker ? resolveRuntimeWorkerUrl(worker.entrypoint) : workerUrl;
}
