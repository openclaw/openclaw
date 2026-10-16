import { once } from "node:events";
import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import {
  readSqliteDatabaseAdmissionDeadline,
  withSqliteDatabaseAdmissionWait,
} from "./sqlite-worker-database-admission-relay.js";

it("retains the caller deadline until asynchronous work settles", async () => {
  const resume = Promise.withResolvers<void>();
  const deadlineAtMs = Date.now() + 1_000;
  const pending = withSqliteDatabaseAdmissionWait({ deadlineAtMs }, async () => {
    await resume.promise;
    return readSqliteDatabaseAdmissionDeadline();
  });
  resume.resolve();
  await expect(pending).resolves.toBe(deadlineAtMs);
});

it("does not carry a completed operation's deadline into the next operation on a retained worker", async () => {
  const channel = new MessageChannel();
  channel.port1.on("message", (request: { port: MessagePort; decision: SharedArrayBuffer }) => {
    request.port.postMessage([], []);
    Atomics.store(new Int32Array(request.decision), 0, 1);
    Atomics.notify(new Int32Array(request.decision), 0);
    request.port.close();
  });
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const { AsyncResource } = require("node:async_hooks");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { exchangeSqliteDatabaseAdmissions, withSqliteDatabaseAdmissionWait } = await import(workerData.relay);
       let retained;
       parentPort.on("message", (operation) => {
         try {
           const exchange = () => exchangeSqliteDatabaseAdmissions(workerData.port, []);
           const value = operation === "expired"
             ? withSqliteDatabaseAdmissionWait({ deadlineAtMs: Date.now() - 1 }, () => {
                 retained = new AsyncResource("retained-worker-owner");
                 return exchange();
               })
             : retained.runInAsyncScope(() => withSqliteDatabaseAdmissionWait({}, exchange));
           parentPort.postMessage({ operation, value });
         } catch (error) {
           parentPort.postMessage({ operation, message: error.message, code: error.code });
         }
       });
       parentPort.postMessage({ ready: true });
     })().catch((error) => { throw error; });`,
    {
      eval: true,
      execArgv: [],
      workerData: {
        port: channel.port2,
        loader: import.meta.resolve("tsx/esm/api"),
        relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      },
      transferList: [channel.port2],
    },
  );
  try {
    await once(worker, "message");
    const expired = once(worker, "message");
    worker.postMessage("expired", []);
    expect((await expired)[0]).toMatchObject({ operation: "expired", code: "unavailable" });
    const next = once(worker, "message");
    worker.postMessage("next", []);
    expect((await next)[0]).toEqual({ operation: "next", value: [] });
  } finally {
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
  }
});

it.each([
  { name: "the caller's remaining deadline", budgetMs: 1_000 },
  { name: "the ten-minute safety bound without a caller deadline", budgetMs: undefined },
])("bounds a vanished admission peer by $name", async ({ budgetMs }) => {
  const channel = new MessageChannel();
  const elapsed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let decision: Int32Array | undefined;
  let waitedPastThirtySeconds = false;
  channel.port1.once("message", (request: { port: MessagePort; decision: SharedArrayBuffer }) => {
    request.port.close();
    channel.port1.close();
    decision = new Int32Array(request.decision);
    // A slow host can still answer after 112s. Only the caller's budget may
    // shorten the ten-minute abandoned-peer bound.
    Atomics.store(elapsed, 0, budgetMs === undefined ? 112_000 : budgetMs + 1);
    Atomics.notify(decision, 0);
  });
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { exchangeSqliteDatabaseAdmissions, withSqliteDatabaseAdmissionWait } = await import(workerData.relay);
       const monotonic = process.hrtime.bigint.bind(process.hrtime);
       const elapsed = new Int32Array(workerData.elapsed);
       process.hrtime.bigint = () => monotonic() + BigInt(Atomics.load(elapsed, 0)) * 1_000_000n;
       const wait = Atomics.wait;
       Atomics.wait = (array, index, value, timeout) => {
         if (Atomics.load(elapsed, 0) === 112_000) parentPort.postMessage({ waiting: timeout });
         return wait(array, index, value, timeout);
       };
       parentPort.postMessage({ ready: true });
       try {
         const exchange = () => exchangeSqliteDatabaseAdmissions(workerData.port, []);
         if (workerData.budgetMs === undefined) exchange();
         else withSqliteDatabaseAdmissionWait({ deadlineAtMs: Date.now() + workerData.budgetMs }, exchange);
         parentPort.postMessage({ unexpectedSuccess: true });
       } catch (error) {
         parentPort.postMessage({ message: error.message, code: error.code });
       } finally {
         workerData.port.close();
         parentPort.close();
       }
     })().catch((error) => { throw error; });`,
    {
      eval: true,
      execArgv: [],
      workerData: {
        port: channel.port2,
        elapsed: elapsed.buffer,
        budgetMs,
        loader: import.meta.resolve("tsx/esm/api"),
        relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      },
      transferList: [channel.port2],
    },
  );
  try {
    const result = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message) => {
        if ("waiting" in message) {
          waitedPastThirtySeconds = true;
          expect(message.waiting).toBeGreaterThan(480_000);
          expect(message.waiting).toBeLessThanOrEqual(488_000);
          Atomics.store(elapsed, 0, 600_001);
          // A late decision also prevents a lost wake if the worker has not parked yet.
          Atomics.store(decision!, 0, 1);
          Atomics.notify(decision!, 0);
        } else if (!("ready" in message)) {
          resolve(message);
        }
      });
    });
    expect(waitedPastThirtySeconds).toBe(budgetMs === undefined);
    expect(result).toEqual({
      message: "SQLite admission facts exchange timed out; the host did not reply",
      code: "unavailable",
    });
    await once(worker, "exit");
  } finally {
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
  }
});
