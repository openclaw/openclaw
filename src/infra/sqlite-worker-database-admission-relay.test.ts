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
  let waitedPastThirtySeconds = false;
  channel.port1.once("message", (request: { port: MessagePort }) => {
    request.port.close();
    channel.port1.close();
  });
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { exchangeSqliteDatabaseAdmissions, withSqliteDatabaseAdmissionWait } = await import(workerData.relay);
       const monotonic = process.hrtime.bigint.bind(process.hrtime);
       let elapsed = 0;
       process.hrtime.bigint = () => monotonic() + BigInt(elapsed) * 1_000_000n;
       // Advance at the wait boundary so fake time cannot race a native park.
       Atomics.wait = (array, index, _value, timeout) => {
         if (elapsed === 112_000) {
           parentPort.postMessage({ waiting: timeout });
           elapsed = 600_001;
           // A late grant must still lose to the exhausted budget.
           Atomics.store(array, index, 1);
         } else {
           // A slow host can answer after 112s; only the caller may shorten the bound.
           elapsed = workerData.budgetMs === undefined ? 112_000 : workerData.budgetMs + 1;
         }
         return "timed-out";
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
        budgetMs,
        loader: import.meta.resolve("tsx/esm/api"),
        relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      },
      transferList: [channel.port2],
    },
  );
  try {
    const result = await new Promise((resolve, reject) => {
      let reply: unknown;
      worker.on("error", reject);
      // Exit can drain the result message and fire before an await continuation.
      worker.once("exit", () => resolve(reply));
      worker.on("message", (message) => {
        if ("waiting" in message) {
          waitedPastThirtySeconds = true;
          expect(message.waiting).toBeGreaterThan(480_000);
          expect(message.waiting).toBeLessThanOrEqual(488_000);
        } else if (!("ready" in message)) {
          reply = message;
        }
      });
    });
    expect(waitedPastThirtySeconds).toBe(budgetMs === undefined);
    expect(result).toEqual({
      message: "SQLite admission facts exchange timed out; the host did not reply",
      code: "unavailable",
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
  }
});
