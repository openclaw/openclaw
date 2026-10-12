import { Worker, workerData } from "node:worker_threads";
import { resolveRuntimeWorkerThreadExecArgv } from "../../src/infra/runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  installSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "../../src/infra/sqlite-database-admission.js";

export function startAdmittedTestWorker(url: URL, databasePath: string, input: unknown) {
  return new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: {
      input,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location: databasePath }),
    },
  });
}

export function installTestWorkerAdmissions(): void {
  const data: { admissions: SqliteDatabaseAdmissions } = workerData;
  installSqliteDatabaseAdmissions(data.admissions);
}

export { hasSqliteWorkerOutcomeUnknown } from "../../src/infra/sqlite-worker-contract.js";
