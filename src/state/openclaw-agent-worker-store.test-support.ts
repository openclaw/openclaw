import { writeFileSync } from "node:fs";
import { threadId } from "node:worker_threads";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-store.js";

export type AgentWorkerFixtureOperations = {
  append: {
    input: { value: string; transactionMarker?: string; commitMarker?: string; delayMs?: number };
    output: number;
  };
};

export function openExistingSqliteWorkerBackend(
  connectionInput: { openMarker?: string } | undefined,
  { databasePath }: { databasePath: string },
): SqliteWorkerBackend<AgentWorkerFixtureOperations> {
  if (connectionInput?.openMarker) {
    writeFileSync(connectionInput.openMarker, "factory entered");
  }
  const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(databasePath));
  const pause = (marker: string | undefined, milliseconds: number) => {
    if (marker) {
      writeFileSync(marker, "entered");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  };
  return {
    execute({ input }) {
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          pause(input.transactionMarker, input.delayMs ?? 200);
          db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(input.value);
          return threadId;
        },
        {
          withCommit(commit) {
            requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
            pause(input.commitMarker, input.delayMs ?? 200);
            commit();
          },
        },
      );
    },
    close() {
      db.close();
    },
  };
}
