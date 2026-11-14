import { note } from "../../packages/terminal-core/src/note.js";
import { getPostgresPool } from "../infra/postgres-sync/pool.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveSqliteInspectionSignal } from "../infra/sqlite-readonly-worker.js";
import { captureSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { BLOAT_MIN_FILE_BYTES } from "./doctor-db-bloat.constants.js";
import type { SqliteBloatStats } from "./doctor-db-bloat.read.js";
import type {
  DoctorDatabaseBloatInput,
  DoctorDatabaseBloatResult,
} from "./doctor-db-bloat.worker.js";
import { formatBytes } from "./doctor-disk-space.js";

const BLOAT_MIN_FREE_BYTES = 32 * 1024 * 1024;
const BLOAT_FREE_RATIO = 0.25;
const LARGE_DB_WARN_BYTES = 1024 * 1024 * 1024;

function describeBloat(label: string, stats: SqliteBloatStats): string | null {
  const freeRatio = stats.fileBytes > 0 ? stats.freeBytes / stats.fileBytes : 0;
  const isBloated =
    stats.fileBytes >= BLOAT_MIN_FILE_BYTES &&
    stats.freeBytes >= BLOAT_MIN_FREE_BYTES &&
    freeRatio >= BLOAT_FREE_RATIO;
  if (isBloated) {
    const remedy = stats.incrementalAutoVacuum
      ? "incremental vacuum will release it gradually"
      : "use offline Doctor SQLite compaction to reclaim it and enable incremental vacuum (gateway stopped; see https://docs.openclaw.ai/cli/doctor/sqlite-maintenance)";
    return `${label}: ${formatBytes(stats.fileBytes)} on disk with ${formatBytes(stats.freeBytes)} reclaimable free pages; ${remedy}.`;
  }
  if (stats.fileBytes >= LARGE_DB_WARN_BYTES) {
    return `${label}: ${formatBytes(stats.fileBytes)} on disk; review session/transcript retention settings if growth is unexpected.`;
  }
  return null;
}

export async function noteSqliteDatabaseBloat(deps?: { env?: NodeJS.ProcessEnv }): Promise<void> {
  const context = captureOpenClawStateReadWorkerContext({ env: deps?.env });
  if (Object.values(context.databaseEngineSelection?.effectiveEngines ?? {}).includes("postgres")) {
    getPostgresPool();
  }
  const pool = new WorkerTaskPool<DoctorDatabaseBloatInput, DoctorDatabaseBloatResult>({
    workerUrl: captureRuntimeWorkerSource(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.doctorDatabaseBloat),
    ).moduleUrl,
    maxWorkers: 1,
  });
  let results: DoctorDatabaseBloatResult;
  try {
    results = await pool.run(
      {
        path: context.admission.databasePath,
        context: captureSqliteWorkerStateContext(context),
      },
      { signal: resolveCommandProcessSignal(resolveSqliteInspectionSignal(getAsyncWorkSignal())) },
    );
  } finally {
    await pool.close();
  }
  context.admission.assertCurrent();
  const warnings = (results ?? []).flatMap(({ label, stats }) => {
    const warning = describeBloat(label, stats);
    return warning ? [warning] : [];
  });
  if (warnings.length === 0) {
    return;
  }
  note(warnings.join("\n"), "SQLite database size");
}
