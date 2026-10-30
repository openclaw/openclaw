import childProcess from "node:child_process";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const SQLITE_HEADER_PROBE_BATCH_SIZE = 4096;

/** Probe discovery batches without disturbing live SQLite file locks. */
export function probeSqliteDatabaseHeaders(pathnames: Iterable<string>): Map<string, boolean> {
  const paths = [...new Set(pathnames)];
  if (paths.length === 0) {
    return new Map();
  }
  const results = new Map<string, boolean>();
  try {
    const workerArgv = resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteHeaderProbe),
    );
    for (let start = 0; start < paths.length; start += SQLITE_HEADER_PROBE_BATCH_SIZE) {
      const batch = paths.slice(start, start + SQLITE_HEADER_PROBE_BATCH_SIZE);
      // Closing a raw descriptor could release another connection's POSIX locks
      // on the same inode. Bound each child’s work while preserving that isolation.
      const result = childProcess.spawnSync(process.execPath, workerArgv, {
        input: JSON.stringify(batch),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(
          `Header probe exited with status ${result.status}: ${result.stderr.trim()}`,
        );
      }
      const answers: unknown = JSON.parse(result.stdout);
      if (
        !Array.isArray(answers) ||
        answers.length !== batch.length ||
        !answers.every((answer): answer is boolean => typeof answer === "boolean")
      ) {
        throw new Error("Header probe returned an incomplete result");
      }
      for (let index = 0; index < batch.length; index++) {
        results.set(batch[index]!, answers[index]!);
      }
    }
    return results;
  } catch (cause) {
    throw new Error(
      "Could not determine whether backup files are SQLite databases. " +
        "Check that the backup worker can run and the source files are readable, then retry the backup.",
      { cause },
    );
  }
}
