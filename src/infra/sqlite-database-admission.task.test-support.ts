import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerBackend,
  type AdmissionOperations,
} from "./sqlite-database-admission.worker.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type AdmissionTaskInput = {
  path?: string;
  awaitPublication?: boolean;
  nested?: boolean;
  broker?: boolean;
  creationPath?: string;
  measureHostAbsence?: boolean;
  holdMutation?: SharedArrayBuffer;
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
    try {
      return await pool.run(
        {
          path: input.path,
          broker: input.broker === true,
          creationPath: typeof input.creationPath === "string" ? input.creationPath : undefined,
          measureHostAbsence: input.measureHostAbsence === true,
        },
        {},
      );
    } finally {
      await pool.close();
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
      if (input.holdMutation instanceof SharedArrayBuffer) {
        assert.ok(channel);
        const wait = input.holdMutation;
        await broker.runOperation(
          store,
          (scope) =>
            scope.execute({
              type: "mutateHeld",
              input: { rollback: false, exit: false, wait: true },
            }),
          undefined,
          undefined,
          () => ({
            nativeLocations: [databasePath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              assert.ok(grant());
              channel.notify("descendant-held");
            }, wait),
          }),
        );
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
