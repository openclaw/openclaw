import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import {
  listDatabaseEngineStores,
  selectDatabaseEngine,
} from "../infra/database-engine/registry.js";
import { resolveStatePortRoots } from "../infra/database-engine/state-port.js";
import type { DatabaseEngineFamily, DatabaseEngineId } from "../infra/database-engine/types.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine, type BackupEngine } from "../snapshot/database-backup.js";

type Input = { config: OpenClawConfig; stateDir: string; env: NodeJS.ProcessEnv };
export type ObservedDatabaseEngines = Partial<Record<DatabaseEngineFamily, DatabaseEngineId[]>>;
export type DoctorDatabaseEngineInspection = {
  observed: ObservedDatabaseEngines;
  stateRoots: { path: string; physical: BackupEngine }[];
  discoveryFailed: boolean;
};

/** Physical evidence stays in a worker and uses artifact-preserving anchor reads. */
export async function inspectDoctorDatabaseEngines(
  input: Input,
): Promise<DoctorDatabaseEngineInspection> {
  const pool = new WorkerTaskPool<Input, DoctorDatabaseEngineInspection>({
    workerUrl: captureRuntimeWorkerSource(new URL(import.meta.url)).moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { doctorDatabaseEngines: true } },
  });
  try {
    return await pool.run(input, {});
  } finally {
    await pool.close();
  }
}

if (parentPort && workerData?.doctorDatabaseEngines === true) {
  const { serveWorkerTasks } = await import("../infra/worker-task-server.js");
  serveWorkerTasks<DoctorDatabaseEngineInspection>(async (value) => {
    // SAFETY: The Doctor host supplies this private, serializable input.
    const input = value as Input;
    const result: DoctorDatabaseEngineInspection = {
      observed: {},
      stateRoots: [],
      discoveryFailed: false,
    };
    const inspected = new Set<string>();
    const inspect = (file: string, family: keyof ObservedDatabaseEngines) => {
      if (inspected.has(file) || !fs.existsSync(file)) {
        return;
      }
      inspected.add(file);
      try {
        const physical = readBackupEngine(file);
        const engines = (result.observed[family] ??= []);
        if (!engines.includes(physical.engine)) {
          engines.push(physical.engine);
        }
        if (family === "state") {
          result.stateRoots.push({ path: file, physical });
        }
      } catch {
        // Unreadable stores have no engine evidence; schema/admission checks report them.
        result.discoveryFailed = true;
      }
    };
    for (const file of resolveStatePortRoots(input)) {
      inspect(file, "state");
    }
    const discover = async () => {
      const plugins = resolvePluginMetadataSnapshot(input);
      const roots = await Promise.all(
        databasePortProviders.map(async (provider) => ({
          family: listDatabaseEngineStores().find((family) => family.id === provider.id),
          paths: (await provider.resolveRoots({ ...input, plugins })).map((root) =>
            fs.existsSync(root) ? fs.realpathSync(root) : root,
          ),
        })),
      );
      for (const file of await discoverBackupDatabasePaths(input)) {
        const owner = roots.find(({ paths }) =>
          paths.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
        );
        if (owner?.family) {
          inspect(file, owner.family.id);
        }
      }
    };
    try {
      // Plugin inventory reads shared state. An unrelated family's unavailable
      // connection must not hide SQLite state roots from Doctor.
      if (selectDatabaseEngine({ id: "state", postgres: true }, input.config) === "postgres") {
        const selection = await resolveDatabaseEngineSelection(input.config, input.env);
        await withDatabaseEngineSelection(selection, discover);
      } else {
        await discover();
      }
    } catch {
      // Keep already observed state evidence and never expose connection errors.
      result.discoveryFailed = true;
    }
    return result;
  });
}
