import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import {
  getScopedDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import type {
  UpdatePostgresStateInput,
  UpdatePostgresStateReply,
  UpdatePostgresStateTask,
} from "./update-candidate-state.postgres.types.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

/** Registry, versions and plugin facts share one read snapshot on the admitted store. */
export async function readUpdatePostgresState(
  input: UpdatePostgresStateInput,
  files: Map<string, StateDatabaseDiscovery>,
  sourcePath?: string,
): Promise<UpdatePostgresStateReply> {
  const pool = new WorkerTaskPool<UpdatePostgresStateTask, UpdatePostgresStateReply>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updatePostgresState),
    maxWorkers: 1,
  });
  try {
    const { stateDir, config, env, includeRetainedAgentPaths } = input;
    const selection =
      getScopedDatabaseEngineSelection() ??
      (await resolveDatabaseEngineSelection(config, { ...process.env, ...env }));
    return await withDatabaseEngineSelection(selection, () =>
      pool.run(
        {
          input: { stateDir, config, env: env && { ...env }, includeRetainedAgentPaths },
          files: [...files],
          sourcePath,
        },
        {},
      ),
    );
  } finally {
    await pool.close();
  }
}

/** Retained agents and plugin stores use their physical provider, independent of state. */
export async function readUpdatePostgresStoreVersion(
  input: UpdatePostgresStateInput,
  sourcePath: string,
): Promise<number> {
  return (await readUpdatePostgresState(input, new Map(), sourcePath)).version.userVersion;
}
