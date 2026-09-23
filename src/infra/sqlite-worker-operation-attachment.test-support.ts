import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { AttachmentFixtureOperations } from "./sqlite-worker-operation-attachment-backend.test-support.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import { openSqliteWorkerStore, runSqliteWorkerStoreOperation } from "./sqlite-worker-store.js";

/** Exercise attachment transfer through the same broker and framing as production commands. */
export async function runSqliteWorkerAttachmentFramingProof(databasePath: string) {
  assert.equal(existsSync(databasePath), false);
  const store = await openSqliteWorkerStore<AttachmentFixtureOperations>({
    moduleUrl: new URL(
      "./sqlite-worker-operation-attachment-backend.test-support.ts",
      import.meta.url,
    ),
    databasePath,
    input: undefined,
  });
  let admissionRequests = 0;
  const settlements: Promise<SqliteWorkerOperationSettlement>[] = [];
  const receipts: Array<{ payloadBytes: number; result: unknown }> = [];
  try {
    for (const size of [32, SQLITE_WORKER_MAX_MESSAGE_BYTES + 1]) {
      const word = new Int32Array(new SharedArrayBuffer(32));
      const value = "x".repeat(size);
      const result = await runSqliteWorkerStoreOperation(
        store,
        (scope) => scope.execute({ type: "inspect", input: { value } }),
        undefined,
        undefined,
        (operation) => {
          settlements.push(operation.settled);
          return {
            admission: createSqliteWorkerOperationAdmission(
              (request, grant) => {
                assert.deepEqual(request, { stage: "prepare", facts: "ordinary-js-backend" });
                admissionRequests++;
                assert.equal(grant(), true);
              },
              { label: "ordinary-attachment", word: word.buffer },
            ),
            nativeLocations: [],
          };
        },
      );
      assert.equal(Atomics.load(word, 0), 1);
      assert.deepEqual(result, {
        length: size,
        digest: createHash("sha256").update(value).digest("hex"),
        executions: receipts.length + 1,
      });
      receipts.push({ payloadBytes: size, result });
    }
    assert.deepEqual(await Promise.all(settlements), [
      { kind: "completed" },
      { kind: "completed" },
    ]);
  } finally {
    await store.close();
  }
  assert.equal(existsSync(databasePath), true);
  return { receipts, admissionRequests, backendClosed: true, databaseCreated: true };
}
