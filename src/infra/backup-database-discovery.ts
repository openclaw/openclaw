import { parentPort, workerData } from "node:worker_threads";
import {
  resolveActivatedPluginBackupInventory,
  type ActivatedPluginBackupInventory,
} from "../plugins/manifest-backup-resources.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { discoverBackupDatabasePaths } from "./backup-sqlite-snapshot.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

type Input = Parameters<typeof discoverBackupDatabasePaths>[0] & {
  workspaceDirs?: readonly string[];
};
type Reply = {
  paths: string[];
  stateRoots: readonly string[];
  pluginOwners: DatabasePortPluginOwners;
  pluginInventory: ActivatedPluginBackupInventory;
};

/** Plugin discovery may read shared state, so PostgreSQL discovery belongs in a worker. */
export async function preparePostgresBackupDiscovery(input: Input) {
  const pool = new WorkerTaskPool<Input, Reply>({
    workerUrl: captureRuntimeWorkerSource(new URL(import.meta.url)).moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { databaseDiscovery: true } },
  });
  try {
    const { stateDir, config, env, agentRegistry, workspaceDirs } = input;
    return await pool.run({ stateDir, config, env, agentRegistry, workspaceDirs }, {});
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.databaseDiscovery === true) {
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  serveWorkerTasks<Reply>(async (value) => {
    // SAFETY: The private discovery host supplies this typed, serializable input.
    const input = value as Input;
    const selected = await resolveDatabaseEngineSelection(input.config, {
      ...process.env,
      ...input.env,
    });
    return withDatabaseEngineSelection(selected, async () => {
      const paths = await discoverBackupDatabasePaths(input);
      const plugins = resolvePluginMetadataSnapshot(input);
      const pluginOwners = Object.fromEntries(
        plugins.plugins.map(({ id, rootDir, source, origin }) => [
          id,
          { id, rootDir, source, origin },
        ]),
      );
      return {
        paths,
        stateRoots: await statePortProvider.resolveRoots({
          ...input,
          env: input.env ?? process.env,
          plugins,
        }),
        pluginOwners,
        pluginInventory: resolveActivatedPluginBackupInventory(input),
      };
    });
  });
}
