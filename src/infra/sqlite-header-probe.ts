import childProcess from "node:child_process";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

/** Probe one discovery batch without disturbing live SQLite file locks. */
export function probeSqliteDatabaseHeaders(pathnames: Iterable<string>): Map<string, boolean> {
  const paths = [...new Set(pathnames)];
  if (paths.length === 0) {
    return new Map();
  }
  try {
    // Closing a raw descriptor could release another connection's POSIX locks
    // on the same inode. Probe in a child that owns no database connections.
    const result = childProcess.spawnSync(
      process.execPath,
      resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteHeaderProbe),
      ),
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
    return new Map(paths.map((pathname, index) => [pathname, answers[index]!]));
  } catch (cause) {
    throw new Error(
      "Could not determine whether backup files are SQLite databases. " +
        "Check that the backup worker can run and the source files are readable, then retry the backup.",
      { cause },
    );
  }
}
