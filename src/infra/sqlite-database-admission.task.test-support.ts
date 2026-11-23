import assert from "node:assert/strict";
import { MessagePort, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerBackend,
  type AdmissionOperations,
} from "./sqlite-database-admission.worker.test-support.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type AdmissionTaskInput = {
  path?: string;
  awaitPublication?: boolean;
  nested?: boolean;
  broker?: boolean;
  creationPath?: string;
  measureHostAbsence?: boolean;
  createPumpGate?: SharedArrayBuffer;
  writeProof?: boolean;
};
export type AdmissionTaskResult = AdmissionOperations["admitted"]["output"];

serveWorkerTasks<AdmissionTaskResult>(async (input, channel) => {
  assert.ok(isRecord(input));
  if (input.path === undefined) {
    return { threadId, sql: [] };
  }
  assert.ok(typeof input.path === "string");
  const databasePath = input.path;
  if (input.nested) {
    const { createOwnedWorkerTaskPool } = await import("./worker-task-pool.js");
    const pool = createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>({
      workerUrl: new URL(import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    });
    const postMessageDescriptor = Object.getOwnPropertyDescriptor(
      MessagePort.prototype,
      "postMessage",
    );
    assert(postMessageDescriptor);
    const originalPostMessage: unknown = postMessageDescriptor.value;
    assert(typeof originalPostMessage === "function");
    const gate =
      input.createPumpGate instanceof SharedArrayBuffer
        ? new Int32Array(input.createPumpGate)
        : undefined;
    if (gate) {
      MessagePort.prototype.postMessage = function (...args) {
        const message: unknown = args[0];
        if (
          isRecord(message) &&
          message.kind === "sqlite-database-admissions" &&
          message.create === "admitted" &&
          Atomics.compareExchange(gate, 0, 0, 1) === 0
        ) {
          Atomics.notify(gate, 0);
          assert.notEqual(Atomics.wait(gate, 1, 0, 10_000), "timed-out");
        }
        Reflect.apply(originalPostMessage, this, args);
      };
    }
    try {
      return await pool.run(
        {
          path: input.path,
          broker: input.broker === true,
          writeProof: input.writeProof === true,
          creationPath: typeof input.creationPath === "string" ? input.creationPath : undefined,
          measureHostAbsence: input.measureHostAbsence === true,
        },
        {},
      );
    } finally {
      try {
        await pool.close();
      } finally {
        Object.defineProperty(MessagePort.prototype, "postMessage", postMessageDescriptor);
      }
    }
  }
  if (input.broker) {
    const { SqliteWorkerBroker } = await import("./sqlite-worker-broker.js");
    const broker = new SqliteWorkerBroker();
    try {
      const store = await broker.open<AdmissionOperations>({
        moduleUrl: new URL("./sqlite-database-admission.worker.test-support.ts", import.meta.url),
        databasePath,
        input: {
          creationPath: typeof input.creationPath === "string" ? input.creationPath : undefined,
        },
      });
      assert.ok(store);
      if (input.writeProof === true) {
        await store.execute({
          type: "writeRows",
          input: {
            sql: "CREATE TABLE nested_creation_proof(value INTEGER); INSERT INTO nested_creation_proof VALUES (42)",
          },
        });
      }
      return await store.execute({
        type: "admitted",
        input: input.measureHostAbsence === true ? { measureHostAbsence: true } : undefined,
      });
    } finally {
      await broker.close();
    }
  }
  if (input.awaitPublication) {
    assert.ok(channel);
    const response = await channel.request("publish admission");
    response.consumed();
  }
  const backend = createSqliteWorkerBackend(undefined, { databasePath: input.path });
  try {
    return backend.execute({
      type: "admitted",
      input: input.measureHostAbsence === true ? { measureHostAbsence: true } : undefined,
    });
  } finally {
    backend.close();
  }
});
