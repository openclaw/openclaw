import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { readBackupEngine } from "../snapshot/database-backup.js";
import { admitStatePostgres, stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { databaseEngineAdapters } from "./database-engine/adapters.js";
import { resolveDatabaseEngineInput } from "./database-engine/config.js";
import {
  admitPostgresPhysicalFacts,
  getPostgresPhysicalFacts,
} from "./database-engine/physical-facts.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import {
  readUpdateCandidatePluginIndex,
  type UpdateCandidatePluginIndex,
} from "./update-candidate-plugins.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";
import { readUpdateHeldAgentPaths } from "./update-candidate-state.retained.js";
import { collectRegisteredPaths, type StateInput } from "./update-candidate-state.shared.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

type Input = StateInput;
type Task = { input: Input; files: [string, StateDatabaseDiscovery][] };
type Reply = {
  files: Task["files"];
  version: Omit<UpdateStateSchemaVersion, "path">;
  pluginIndex?: UpdateCandidatePluginIndex;
};

/** Registry, versions and plugin facts share one admitted read-only PostgreSQL snapshot. */
export async function readUpdatePostgresState(
  input: Input,
  files: Map<string, StateDatabaseDiscovery>,
): Promise<Reply> {
  const pool = new WorkerTaskPool<Task, Reply>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
    workerOptions: { workerData: { updatePostgresState: true } },
  });
  try {
    const { stateDir, config, env, includeRetainedAgentPaths } = input;
    return await pool.run(
      { input: { stateDir, config, env, includeRetainedAgentPaths }, files: [...files] },
      {},
    );
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.updatePostgresState === true) {
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  serveWorkerTasks<Reply>(async (value) => {
    // SAFETY: The private one-shot host is the sole producer of this typed task.
    const { input, files: entries } = value as Task;
    const inputEngine = await resolveDatabaseEngineInput(input.config, {
      ...process.env,
      ...input.env,
    });
    if (!inputEngine) {
      throw new Error("PostgreSQL update preflight requires the configured state connection.");
    }
    const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
    const identity = readBackupEngine(shared);
    if (identity.engine !== "postgres") {
      throw new Error("PostgreSQL update preflight requires the matching state anchor.");
    }
    using anchor = openNodeSqliteDatabase(shared, { readOnly: true });
    const db = databaseEngineAdapters.postgres.openConnection({
      anchor,
      schema: stateEngineSchema,
      input: inputEngine,
      storeId: identity.storeId,
      namespace: identity.namespace,
      openSqlite() {},
    });
    try {
      // Bind the worker's host admission record before staging facts in a read transaction.
      getPostgresPhysicalFacts(db);
      return databaseEngineAdapters.postgres.transactions.read(db, () => {
        // Preflight never bootstraps, migrates or seals a source schema.
        admitPostgresPhysicalFacts({
          anchor,
          db,
          ...identity,
          store: "state",
          version: stateEngineSchema.version,
        });
        admitStatePostgres(db, false);
        const files = new Map(entries);
        const registered = collectRegisteredPaths(db, shared, files);
        const held = input.includeRetainedAgentPaths
          ? readUpdateHeldAgentPaths(db, shared, files.values(), registered, input)
          : [];
        return {
          version: {
            userVersion: getPostgresPhysicalFacts(db)!.version,
            contentVersion: readStateSchemaContentVersion(db),
            ...(held.length ? { retainedAgentPaths: held } : {}),
          },
          pluginIndex: readUpdateCandidatePluginIndex(db),
          files: [...files],
        };
      });
    } finally {
      db.close();
    }
  });
}
