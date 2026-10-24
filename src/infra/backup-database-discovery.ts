import type {
  BackupDatabaseDiscoveryInput,
  BackupDatabaseDiscoveryReply,
} from "./backup-database-discovery.types.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

/** Plugin discovery may read shared state, so PostgreSQL discovery belongs in a worker. */
export async function preparePostgresBackupDiscovery(input: BackupDatabaseDiscoveryInput) {
  const pool = new WorkerTaskPool<BackupDatabaseDiscoveryInput, BackupDatabaseDiscoveryReply>({
    workerUrl: captureRuntimeWorkerSource(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.backupDatabaseDiscovery),
    ).moduleUrl,
    maxWorkers: 1,
  });
  try {
    const { stateDir, config, env, agentRegistry, workspaceDirs } = input;
    return await pool.run(
      { stateDir, config, env: env && { ...env }, agentRegistry, workspaceDirs },
      {},
    );
  } finally {
    await pool.close();
  }
}
