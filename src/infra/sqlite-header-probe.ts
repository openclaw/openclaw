import childProcess from "node:child_process";
import { formatErrorMessage } from "./errors.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

// Each child gets its own deadline, so the budget never depends on how many
// files a state directory holds.
export const SQLITE_HEADER_PROBE_BATCH_SIZE = 4096;

function probeChunk(paths: string[]): boolean[] {
  // Closing a raw descriptor could release another connection's POSIX locks
  // on the same inode. Probe in a child that owns no database connections.
  const result = childProcess.spawnSync(
    process.execPath,
    resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteHeaderProbe)),
    {
      input: JSON.stringify(paths),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Header probe exited with status ${result.status}: ${result.stderr.trim()}`);
  }
  const answers: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(answers) ||
    answers.length !== paths.length ||
    !answers.every((answer): answer is boolean => typeof answer === "boolean")
  ) {
    throw new Error("Header probe returned an incomplete result");
  }
  return answers;
}

/** Probe one discovery batch without disturbing live SQLite file locks. */
export function probeSqliteDatabaseHeaders(pathnames: Iterable<string>): Map<string, boolean> {
  const paths = [...new Set(pathnames)];
  const results = new Map<string, boolean>();
  try {
    for (let start = 0; start < paths.length; start += SQLITE_HEADER_PROBE_BATCH_SIZE) {
      const chunk = paths.slice(start, start + SQLITE_HEADER_PROBE_BATCH_SIZE);
      const answers = probeChunk(chunk);
      chunk.forEach((pathname, index) => results.set(pathname, answers[index]!));
    }
    return results;
  } catch (cause) {
    throw new Error(
      "Could not determine whether backup files are SQLite databases. " +
        "Check that the backup worker can run and the source files are readable, then retry the backup. " +
        `Cause: ${formatErrorMessage(cause)}`,
      { cause },
    );
  }
}
