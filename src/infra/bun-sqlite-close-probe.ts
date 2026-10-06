import { channel } from "node:diagnostics_channel";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

type SqliteCloseProbeResult = Readonly<{
  explicitSqliteCloseReleasesNativeResources: boolean;
  reason: string;
}>;

async function cleanupProbe(
  worker: Worker | undefined,
  directory: string | undefined,
  background: boolean,
) {
  try {
    if (worker) {
      if (background) {
        worker.unref();
      }
      await raceWithTimeout(
        worker.terminate(),
        5_000,
        () => {
          throw new Error("SQLite close check termination timed out after 5000ms");
        },
        { ref: !background },
      );
      await nextTurn(undefined, { ref: !background });
    }
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    worker?.unref();
    const reason = `SQLite close check cleanup failed: ${String(error)}; retained ${directory}`;
    process.emitWarning(reason, { code: "SQLITE_CLOSE_PROBE_CLEANUP" });
    return reason;
  }
  return undefined;
}

export async function probeSqliteNativeClose(): Promise<SqliteCloseProbeResult> {
  let directory: string | undefined;
  let worker: Worker | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let result: SqliteCloseProbeResult;
  try {
    directory = await mkdtemp(join(tmpdir(), "openclaw-sqlite-close-"));
    directory = await realpath(directory);
    channel("openclaw.sqlite.close-probe").publish({ phase: "start" });
    worker = new Worker(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteCloseProbe), {
      workerData: directory,
      execArgv: [],
    });
    const running = worker;
    result = await new Promise<SqliteCloseProbeResult>((resolve, reject) => {
      running.once("message", (value: unknown) => {
        if (typeof value !== "string") {
          reject(new Error("Invalid SQLite close check reply"));
          return;
        }
        resolve({
          explicitSqliteCloseReleasesNativeResources: value === "",
          reason: value || "Native close check passed",
        });
      });
      running.once("error", reject);
      running.once("exit", (code) =>
        reject(new Error(`SQLite close check exited before its reply (${code})`)),
      );
      deadline = setTimeout(
        () => reject(new Error("SQLite close check timed out after 10000ms")),
        10_000,
      );
    });
  } catch (error) {
    result = { explicitSqliteCloseReleasesNativeResources: false, reason: String(error) };
  } finally {
    clearTimeout(deadline);
  }
  // A known conservative decision must not wait for a potentially stuck native worker.
  const background = !result.explicitSqliteCloseReleasesNativeResources;
  const cleanup = cleanupProbe(worker, directory, background);
  if (background) {
    void cleanup;
    return result;
  }
  const failure = await cleanup;
  if (failure) {
    return { explicitSqliteCloseReleasesNativeResources: false, reason: failure };
  }
  return result;
}
