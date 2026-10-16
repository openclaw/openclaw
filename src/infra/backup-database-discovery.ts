import { parentPort, workerData } from "node:worker_threads";
import { discoverBackupDatabasePaths } from "./backup-sqlite-snapshot.js";
import { resolveDatabaseEngineInput } from "./database-engine/config.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

type Input = Parameters<typeof discoverBackupDatabasePaths>[0];

/** Plugin discovery may read shared state, so PostgreSQL discovery belongs in a worker. */
export async function discoverPostgresBackupPaths(input: Input) {
  const pool = new WorkerTaskPool<Input, string[]>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
    workerOptions: { workerData: { databaseDiscovery: true } },
  });
  try {
    const { stateDir, config, env } = input;
    return await pool.run({ stateDir, config, env }, {});
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.databaseDiscovery === true) {
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  serveWorkerTasks<string[]>(async (value) => {
    // SAFETY: The private discovery host supplies this typed, serializable input.
    const input = value as Input;
    const selected = await resolveDatabaseEngineInput(input.config, {
      ...process.env,
      ...input.env,
    });
    return withDatabaseEngineSelection({ input: selected }, () =>
      discoverBackupDatabasePaths(input),
    );
  });
}
