import { note } from "../../packages/terminal-core/src/note.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { SqliteBloatStats } from "./doctor-db-bloat.read.js";
import { formatBytes } from "./doctor-disk-space.js";

const BLOAT_MIN_FILE_BYTES = 128 * 1024 * 1024;
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
      : "run `VACUUM` offline (gateway stopped) to reclaim it";
    return `${label}: ${formatBytes(stats.fileBytes)} on disk with ${formatBytes(stats.freeBytes)} reclaimable free pages; ${remedy}.`;
  }
  if (stats.fileBytes >= LARGE_DB_WARN_BYTES) {
    return `${label}: ${formatBytes(stats.fileBytes)} on disk; review session/transcript retention settings if growth is unexpected.`;
  }
  return null;
}

export async function noteSqliteDatabaseBloat(deps?: { env?: NodeJS.ProcessEnv }): Promise<void> {
  const context = captureOpenClawStateWorkerContext({ env: deps?.env });
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const results = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "doctor.databaseBloat", input: undefined }),
    { existingOnly: true },
  );
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
