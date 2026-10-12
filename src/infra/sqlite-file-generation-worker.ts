import { parseSqliteFileGeneration, type SqliteFileGeneration } from "./sqlite-file-generation.js";
import { runSqliteReadOnlyWorker, runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";

/** Raw descriptor closes must not release a sibling connection's process-wide SQLite locks. */
export function readSqliteFileGenerationSync(pathname: string): SqliteFileGeneration {
  return parseSqliteFileGeneration(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "file-generation"),
  );
}

export async function readSqliteFileGeneration(
  pathname: string,
  signal?: AbortSignal,
): Promise<SqliteFileGeneration> {
  return parseSqliteFileGeneration(
    await runSqliteReadOnlyWorker(pathname, { mode: "file-generation", signal }),
  );
}
