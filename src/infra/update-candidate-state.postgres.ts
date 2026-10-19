import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { admitStatePostgres, stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { databaseEngineAdapters } from "./database-engine/adapters.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import {
  getDatabaseEngineInput,
  getDatabaseEngineSelection,
  getScopedDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import {
  admitPostgresPhysicalFacts,
  getPostgresPhysicalFacts,
} from "./database-engine/physical-facts.js";
import { readBackupEngine } from "./database-engine/physical-store.js";
import { withPostgresStoreMetadata } from "./database-engine/postgres-store-metadata.js";
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
type Task = { input: Input; files: [string, StateDatabaseDiscovery][]; sourcePath?: string };
type Reply = {
  files: Task["files"];
  version: Omit<UpdateStateSchemaVersion, "path"> & { userVersion: number };
  pluginIndex?: UpdateCandidatePluginIndex;
};

/** Registry, versions and plugin facts share one admitted read-only PostgreSQL snapshot. */
export async function readUpdatePostgresState(
  input: Input,
  files: Map<string, StateDatabaseDiscovery>,
  sourcePath?: string,
): Promise<Reply> {
  const pool = new WorkerTaskPool<Task, Reply>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
    workerOptions: { workerData: { updatePostgresState: true } },
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
  input: Input,
  sourcePath: string,
): Promise<number> {
  return (await readUpdatePostgresState(input, new Map(), sourcePath)).version.userVersion;
}

if (parentPort && workerData?.updatePostgresState === true) {
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  serveWorkerTasks<Reply>(async (value) => {
    // SAFETY: The private one-shot host is the sole producer of this typed task.
    const { input, files: entries, sourcePath } = value as Task;
    if (sourcePath) {
      const anchor = readBackupEngine(sourcePath);
      if (anchor.engine !== "postgres") {
        throw new Error("PostgreSQL update inspection requires a PostgreSQL anchor.");
      }
      const postgres = getDatabaseEngineSelection()?.postgres;
      if (!postgres) {
        throw new Error("PostgreSQL update inspection requires the captured connection.");
      }
      return withPostgresStoreMetadata(postgres, anchor, async (_client, metadata) => ({
        files: entries,
        version: { userVersion: metadata.version },
      }));
    }
    const inputEngine = getDatabaseEngineInput("state");
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
