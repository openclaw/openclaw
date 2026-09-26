import { Worker } from "node:worker_threads";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resolveStateDatabaseCoordinatorPath,
  type StateDatabaseCoordinatorRuntime,
} from "../infra/state-database-coordinator.js";

/** Hold only the synthetic fixture's coordinator, with release independent of its main thread. */
export function holdStateDatabaseCoordinator(
  databasePath: string,
  runtime: StateDatabaseCoordinatorRuntime,
  releaseAfterMs: number,
) {
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath,
    runtimeDirectory: runtime.directory,
    uid: process.getuid?.(),
  });
  return holdSqliteTransaction(coordinatorPath, "BEGIN EXCLUSIVE", releaseAfterMs);
}

/** Block fixture writes while existing readers and lifecycle owners keep their custody. */
export function holdStateDatabaseWrite(databasePath: string, releaseAfterMs: number) {
  return holdSqliteTransaction(databasePath, "BEGIN IMMEDIATE", releaseAfterMs);
}

function holdSqliteTransaction(
  databasePath: string,
  begin: "BEGIN EXCLUSIVE" | "BEGIN IMMEDIATE",
  releaseAfterMs: number,
) {
  const released = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const ready = createDeferred();
  const holder = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    try { db.exec(workerData.begin); }
    catch (error) {
      const mode = workerData.begin === "BEGIN EXCLUSIVE" ? "exclusive" : "write";
      throw new Error("Contention holder " + mode + " acquisition failed", { cause: error });
    }
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      Atomics.store(new Int32Array(workerData.released), 0, 1);
      db.exec("ROLLBACK");
      db.close();
      parentPort.close();
    };
    const timer = setTimeout(release, workerData.releaseAfterMs);
    parentPort.once("message", release);
    parentPort.postMessage("ready");
  `,
    {
      eval: true,
      execArgv: [],
      env: {},
      workerData: { path: databasePath, begin, released: released.buffer, releaseAfterMs },
    },
  );
  let readyObserved = false;
  let exited = false;
  let failure: Error | undefined;
  const joined = new Promise<number>((resolve, reject) => {
    holder.once("message", () => {
      readyObserved = true;
      ready.resolve();
    });
    holder.once("error", (error: Error) => {
      failure = error;
      ready.reject(error);
    });
    holder.once("exit", (code) => {
      exited = true;
      if (!readyObserved || code !== 0) {
        failure ??= new Error(
          `Contention holder exited ${readyObserved ? "after" : "before"} readiness (code ${code})`,
        );
      }
      if (failure) {
        ready.reject(failure);
        reject(failure);
      } else {
        resolve(code);
      }
    });
  });
  void joined.catch(() => undefined);
  return {
    ready: ready.promise,
    released,
    joined,
    release: () => {
      if (!exited && !failure && Atomics.load(released, 0) === 0) {
        holder.postMessage("release", []);
      }
    },
  };
}
