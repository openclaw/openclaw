import type { WorkerOptions } from "node:worker_threads";

const integrityCounterPreload = `
  import { DatabaseSync } from "node:sqlite";
  import { parentPort, workerData } from "node:worker_threads";
  const databasePath = workerData.operation === "reclaim"
    ? workerData.databaseOptions.path
    : workerData.plan?.databaseOptions.path;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (this.location() === databasePath &&
        /^PRAGMA integrity_check;?$/i.test(sql.trim())) {
      for (const method of ["all", "get", "iterate", "run"]) {
        const execute = statement[method].bind(statement);
        statement[method] = (...args) => {
          Atomics.add(new Int32Array(workerData.integrityChecks), 0, 1);
          if (workerData.integrityRelease) {
            parentPort.postMessage({ type: "test-integrity-check", phase: "checking" });
            Atomics.wait(new Int32Array(workerData.integrityRelease), 0, 0);
          }
          const result = execute(...args);
          if (workerData.integrityRelease) {
            parentPort.postMessage({ type: "test-integrity-check", phase: "checked" });
          }
          return result;
        };
      }
    }
    return statement;
  };
`;

/** Count real full-file checks on the reclamation Worker's native SQLite connection. */
export function withWorkerSqliteIntegrityCounter(
  options: WorkerOptions | undefined,
  counts: SharedArrayBuffer | undefined,
  release?: SharedArrayBuffer,
): WorkerOptions | undefined {
  return counts
    ? {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(integrityCounterPreload)}`,
        ],
        workerData: {
          ...options?.workerData,
          integrityChecks: counts,
          ...(release ? { integrityRelease: release } : {}),
        },
      }
    : options;
}
