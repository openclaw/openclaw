import { Worker } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";

export function spawnConformanceWorker(
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0],
  location: string,
  data: object,
  prepare?: (anchor: ReturnType<typeof openNodeSqliteDatabase>) => void,
) {
  const anchor = openNodeSqliteDatabase(location);
  prepare?.(anchor);
  const url = resolveRuntimeWorkerUrl(entrypoint);
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: { ...data, admissions: captureSqliteDatabaseAdmissions(undefined, { location }) },
  });
  return { anchor, worker };
}

// Wait for exit as well as the reply: receipt alone does not prove worker cleanup finished.
export function conformanceWorkerResult<T extends object>(
  worker: Worker,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T | { error: string } | undefined;
    worker.on("message", (message: typeof result) => {
      result = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0 || !result) {
        reject(new Error(`${label} worker exited ${code} without a result`));
      } else if ("error" in result) {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    });
  });
}
