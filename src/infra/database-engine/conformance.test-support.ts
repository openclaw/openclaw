import { Worker } from "node:worker_threads";
import { installPostgresTestRootGuard } from "../../../test/helpers/postgres-pool-roots.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  createPostgresPoolEndpoints,
  getPostgresPool,
  postgresPoolTransferList,
} from "../postgres-sync/pool.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import type { DatabaseEngineInput } from "./types.js";

export function createConformanceWorker(
  url: URL,
  data: object,
  postgres?: Pick<NonNullable<DatabaseEngineInput>, "connection">,
) {
  installPostgresTestRootGuard();
  if (postgres) {
    // Explicit fixture inputs can precede any process-wide engine selection.
    getPostgresPool();
  }
  const postgresPool = createPostgresPoolEndpoints();
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: { ...data, postgresPool },
    transferList: postgresPoolTransferList(postgresPool),
  });
  return worker;
}

export function spawnConformanceWorker(
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0],
  location: string,
  data: object,
  prepare?: (anchor: ReturnType<typeof openNodeSqliteDatabase>) => void,
  postgres?: Pick<NonNullable<DatabaseEngineInput>, "connection">,
) {
  const anchor = openNodeSqliteDatabase(location);
  prepare?.(anchor);
  const url = resolveRuntimeWorkerUrl(entrypoint);
  const worker = createConformanceWorker(
    url,
    {
      ...data,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location }),
    },
    postgres,
  );
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
