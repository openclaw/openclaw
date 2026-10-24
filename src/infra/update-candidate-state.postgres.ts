import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { openExistingStatePostgresConnectionFromAnchor } from "../state/openclaw-state-db-engine.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { isNativeClientCredentialBootstrap } from "./client-credential-native-bootstrap.js";
import { runEngineStoreReadSnapshot } from "./database-engine/adapters.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import {
  getDatabaseEngineSelection,
  getScopedDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { readBackupEngine } from "./database-engine/physical-store.js";
import { withPostgresStoreMetadata } from "./database-engine/postgres-store-metadata.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
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

/** Registry, versions and plugin facts share one read snapshot on the admitted store. */
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
    const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
    const identity = readBackupEngine(shared);
    if (identity.engine !== "postgres") {
      const snapshot = prepareSqliteReadOnlyLocationSyncInProcess(shared);
      try {
        using source = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
        const credentials = isNativeClientCredentialBootstrap(source);
        const facts = getAdmittedSqliteSchemaFacts(source)!;
        const empty =
          facts.userVersion === 0 &&
          !facts.tables.size &&
          !facts.indexes.size &&
          !facts.views.size &&
          !facts.triggers.size;
        if (credentials) {
          throw new Error(
            "Native credential bootstrap cannot become a PostgreSQL anchor. Start the Gateway once on SQLite and run openclaw doctor --fix, then use openclaw database port before selecting PostgreSQL.",
          );
        }
        if (!empty) {
          throw new Error("PostgreSQL update preflight requires the matching state anchor.");
        }
        return {
          files: entries,
          version: { userVersion: 0, contentVersion: 0 },
          pluginIndex: { value: { index: { installRecords: {} } }, records: {} },
        };
      } finally {
        snapshot.cleanup();
      }
    }
    // Capture already holds maintenance custody; inspection retains its read-only anchor.
    const connection = openExistingStatePostgresConnectionFromAnchor(
      openNodeSqliteDatabase(shared, { readOnly: true }),
      shared,
    );
    const { db } = connection.database;
    try {
      // The existing owner admits the installed version without migrating or resealing it.
      return runEngineStoreReadSnapshot(db, () => {
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
      connection.close();
    }
  });
}
