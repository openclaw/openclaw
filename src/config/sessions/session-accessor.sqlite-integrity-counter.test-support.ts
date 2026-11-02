import type { Worker, WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferred } from "../../../test/helpers/promise.js";

const integrityCounterPreload = `
  import { DatabaseSync } from "node:sqlite";
  import { parentPort, workerData } from "node:worker_threads";
  const databasePath = workerData.integrityDatabasePath ?? (
    workerData.operation === "reclaim"
      ? workerData.databaseOptions.path
      : workerData.plan?.databaseOptions.path
  );
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    const pathControl = workerData.integrityPathControl;
    const targetPath = pathControl
      ? Buffer.from(pathControl).toString("utf8", 4, 4 + Atomics.load(new Int32Array(pathControl, 0, 1), 0))
      : databasePath;
    if (this.location() === targetPath &&
        (/^PRAGMA integrity_check;?$/i.test(sql.trim()) ||
         sql.trim() === "PRAGMA integrity_check('sqlite_schema');")) {
      for (const method of ["all", "get", "iterate", "run"]) {
        const execute = statement[method].bind(statement);
        statement[method] = (...args) => {
          Atomics.add(new Int32Array(workerData.integrityChecks), 0, 1);
          const held = workerData.integrityFirstCheck
            ? Atomics.compareExchange(new Int32Array(workerData.integrityFirstCheck), 0, 0, 1) === 0
            : undefined;
          const report = (phase) => parentPort.postMessage({
            type: "test-integrity-check", phase,
            ...(held === undefined ? {} : { held }),
          });
          if (workerData.integrityRelease) {
            report("checking");
            if (held !== false) {
              Atomics.wait(new Int32Array(workerData.integrityRelease), 0, 0);
            }
          }
          const result = execute(...args);
          if (workerData.integrityRelease) {
            report("checked");
          }
          return result;
        };
      }
    }
    return statement;
  };
`;
const integrityCounterImport = `data:text/javascript,${encodeURIComponent(integrityCounterPreload)}`;

/** Count native admission gates once, through the full check or the schema table. */
export function withWorkerSqliteIntegrityCounter(
  options: WorkerOptions | undefined,
  counts: SharedArrayBuffer | undefined,
  release?: SharedArrayBuffer,
  databasePath?: string,
  firstCheck?: SharedArrayBuffer,
  pathControl?: SharedArrayBuffer,
): WorkerOptions | undefined {
  return counts
    ? {
        ...options,
        execArgv: [...(options?.execArgv ?? []), "--import", integrityCounterImport],
        workerData: {
          ...options?.workerData,
          integrityChecks: counts,
          ...(databasePath ? { integrityDatabasePath: databasePath } : {}),
          ...(release ? { integrityRelease: release } : {}),
          ...(firstCheck ? { integrityFirstCheck: firstCheck } : {}),
          ...(pathControl ? { integrityPathControl: pathControl } : {}),
        },
      }
    : options;
}

/** Arm after fixture preparation, including when the executor is already retained. */
export function createWorkerSqliteIntegrityGate(databasePath = "") {
  const counts = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const firstCheck = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  // Retained workers must see the next case's target without another constructor/preload.
  const pathControl = new SharedArrayBuffer(4 + 4096);
  Atomics.store(new Int32Array(firstCheck), 0, 1);
  let entered = createDeferred();
  const workers = new Set<Worker>();
  const setTargetPath = (targetPath: string) => {
    const encoded = Buffer.from(targetPath);
    if (encoded.length > pathControl.byteLength - 4) {
      throw new Error("Integrity gate path exceeds the fixture buffer");
    }
    new Uint8Array(pathControl, 4).set(encoded);
    Atomics.store(new Int32Array(pathControl, 0, 1), 0, encoded.length);
  };
  setTargetPath(databasePath);
  return {
    get entered() {
      return entered.promise;
    },
    workers,
    arm(targetPath = databasePath) {
      setTargetPath(targetPath);
      entered = createDeferred();
      Atomics.store(new Int32Array(counts), 0, 0);
      Atomics.store(new Int32Array(release), 0, 0);
      Atomics.store(new Int32Array(firstCheck), 0, 0);
    },
    count: () => Atomics.load(new Int32Array(counts), 0),
    release: () => {
      Atomics.store(new Int32Array(release), 0, 1);
      Atomics.notify(new Int32Array(release), 0);
    },
    options: (options?: WorkerOptions) =>
      withWorkerSqliteIntegrityCounter(
        options,
        counts,
        release,
        databasePath,
        firstCheck,
        pathControl,
      ),
    message(worker: Worker, message: unknown) {
      if (!isRecord(message) || message.type !== "test-integrity-check") {
        return false;
      }
      workers.add(worker);
      if (message.phase === "checking" && message.held === true) {
        entered.resolve();
      }
      return true;
    },
  };
}

export function observeWorkerSqliteIntegrity(
  WorkerConstructor: typeof Worker,
  currentGate: () => ReturnType<typeof createWorkerSqliteIntegrityGate> | undefined,
): typeof Worker {
  return class extends WorkerConstructor {
    private readonly integrityGate: ReturnType<typeof currentGate>;

    constructor(filename: string | URL, options?: WorkerOptions) {
      const gate = currentGate();
      super(filename, gate?.options(options) ?? options);
      this.integrityGate = gate;
    }

    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === "message" && this.integrityGate?.message(this, args[0])) {
        return true;
      }
      return super.emit(event, ...args);
    }
  };
}
