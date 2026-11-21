import childProcess from "node:child_process";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { describeLockedBackupSource } from "./backup-locked-source.js";
import { hasErrnoCode } from "./errno.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const SQLITE_HEADER_PROBE_BATCH_SIZE = 4096;
const SQLITE_HEADER_PROBE_TIMEOUT_MS = 10_000;
const log = createSubsystemLogger("backup");

function probeSqliteHeaderBatch(
  workerArgv: string[],
  batch: string[],
  results: Map<string, boolean>,
): void {
  // Closing a raw descriptor could release another connection's POSIX locks
  // on the same inode. Bound each child’s work while preserving that isolation.
  const result = childProcess.spawnSync(process.execPath, workerArgv, {
    input: JSON.stringify(batch),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SQLITE_HEADER_PROBE_TIMEOUT_MS,
  });
  if (result.error) {
    // Cold or slow storage can miss one child's deadline without being stuck.
    // Splitting keeps each deadline, so only a path that cannot answer alone fails.
    if (hasErrnoCode(result.error, "ETIMEDOUT") && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      probeSqliteHeaderBatch(workerArgv, batch.slice(0, middle), results);
      probeSqliteHeaderBatch(workerArgv, batch.slice(middle), results);
      return;
    }
    throw result.error;
  }
  if (result.status === 3) {
    const failure = asOptionalRecord(JSON.parse(result.stderr));
    throw Object.assign(new Error("Header probe could not read a source"), {
      code: failure?.code,
      errno: failure?.errno,
      path: failure?.path,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Header probe exited with status ${result.status}: ${result.stderr.trim()}`);
  }
  const answers: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(answers) ||
    answers.length !== batch.length ||
    !answers.every((answer): answer is boolean => typeof answer === "boolean")
  ) {
    throw new Error("Header probe returned an incomplete result");
  }
  if (result.stderr.trim()) {
    const warning = `SQLite header probe recovered after retrying source reads: ${result.stderr.trim()}`;
    log.warn(warning, { consoleMessage: shortenHomeInString(warning) });
  }
  for (let index = 0; index < batch.length; index++) {
    results.set(batch[index]!, answers[index]!);
  }
}

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
      probeSqliteHeaderBatch(
        workerArgv,
        paths.slice(start, start + SQLITE_HEADER_PROBE_BATCH_SIZE),
        results,
      );
    }
    return results;
  } catch (cause) {
    const failure = asOptionalRecord(cause);
    // A locked managed-browser profile names its stop step; other sources keep the generic hint.
    const browserHint = describeLockedBackupSource(cause);
    const hint = browserHint.includes("--browser-profile")
      ? browserHint
      : typeof failure?.path === "string"
        ? ` Backup source ${shortenHomePath(failure.path)} could not be read (${typeof failure.code === "string" ? failure.code : "unknown error"}). Check read permissions or close the program using it, then retry the backup or update.`
        : " Check that the backup worker can run and the source files are readable, then retry the backup.";
    throw new Error(
      hasErrnoCode(cause, "ETIMEDOUT")
        ? `SQLite header probe timed out after ${SQLITE_HEADER_PROBE_TIMEOUT_MS} ms while checking ${paths.length} backup paths. ` +
            "For a blocked update, preserve a verified backup and follow the manual package-manager hop: " +
            "https://docs.openclaw.ai/install/updating/update-methods#alternative-manual-npm-pnpm-or-bun"
        : `Could not determine whether backup files are SQLite databases.${hint}`,
      { cause },
    );
  }
}
