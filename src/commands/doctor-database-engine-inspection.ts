import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { getPostgresPool } from "../infra/postgres-sync/pool.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  DoctorDatabaseEngineInspection,
  DoctorDatabaseEngineInspectionInput,
} from "./doctor-database-engine-inspection.types.js";
export type {
  DoctorDatabaseEngineInspection,
  ObservedDatabaseEngines,
} from "./doctor-database-engine-inspection.types.js";

/** Operator-only inspection. Never installed in a Gateway request or database hot path. */
export async function inspectDoctorDatabaseEngines(
  input: DoctorDatabaseEngineInspectionInput,
): Promise<DoctorDatabaseEngineInspection> {
  if (Object.values(resolveDatabaseFamilyEngines(input.config)).includes("postgres")) {
    getPostgresPool();
  }
  const pool = new WorkerTaskPool<
    DoctorDatabaseEngineInspectionInput,
    DoctorDatabaseEngineInspection
  >({
    workerUrl: captureRuntimeWorkerSource(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.doctorDatabaseEngineInspection),
    ).moduleUrl,
    maxWorkers: 1,
  });
  try {
    return await pool.run({ ...input, env: { ...input.env } }, {});
  } finally {
    await pool.close();
  }
}
