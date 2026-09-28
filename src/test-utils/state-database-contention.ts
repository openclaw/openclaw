import { Worker } from "node:worker_threads";
import { createDeferred } from "../../test/helpers/promise.js";
/** Hold a fixture's SQLite writer transaction, with release independent of its main thread. */
export function holdStateDatabaseWriteTransaction(databasePath: string, releaseAfterMs: number) {
  const released = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const ready = createDeferred();
  const holder = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    try { db.exec("BEGIN IMMEDIATE"); }
    catch (error) { throw new Error("Contention holder write transaction failed", { cause: error }); }
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
      workerData: { path: databasePath, released: released.buffer, releaseAfterMs },
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
