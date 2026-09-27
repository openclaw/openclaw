import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { waitForFile } from "../../test/helpers/process-wait.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";

export type AgentWorkerFixtureOperations = {
  inspect: { input: undefined; output: number };
  append: {
    input: {
      value: string;
      bytes?: Buffer;
      transactionMarker?: string;
      commitMarker?: string;
      delayMs?: number;
    };
    output: number;
  };
};

export function bindSqliteWorkerBackend(
  connectionInput:
    | {
        openMarker?: string;
        cleanupAdmission?: boolean;
        closeFailure?: string;
        closeWriteValue?: string;
        preparation?: {
          codeMarker: string;
          codeGate: string;
          commandMarker: string;
          commandGate: string;
        };
      }
    | undefined,
  context: {
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerPreparedBackend<AgentWorkerFixtureOperations> {
  const { database: db } = context;
  const preparation = connectionInput?.preparation;
  let codeLoaded = false;
  let preparedValue: string | undefined;
  if (connectionInput?.openMarker) {
    writeFileSync(connectionInput.openMarker, "factory entered");
  }
  const pause = (marker: string | undefined, milliseconds: number) => {
    if (marker) {
      writeFileSync(marker, "entered");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  };
  return {
    [SQLITE_WORKER_PREPARE_COMMAND](commandType) {
      if (!preparation) {
        return undefined;
      }
      if (commandType !== "append") {
        throw new Error("Fixture loader requires the nested command type");
      }
      writeFileSync(preparation.codeMarker, "loading");
      return waitForFile(preparation.codeGate, 5000).then(() => {
        codeLoaded = true;
      });
    },
    prepare(command) {
      if (!preparation) {
        return undefined;
      }
      if (!codeLoaded) {
        throw new Error("Fixture command preparation requires completed code loading");
      }
      if (command.type !== "append") {
        throw new Error("Fixture preparation requires an append command");
      }
      writeFileSync(preparation.commandMarker, "preparing");
      return waitForFile(preparation.commandGate, 5000).then(() => {
        preparedValue = command.input.value;
      });
    },
    execute(command) {
      if (command.type === "inspect") {
        const count = db.prepare("SELECT COUNT(*) AS count FROM worker_proof").get()?.count;
        if (typeof count !== "number") {
          throw new Error("Fixture count is unavailable");
        }
        return count;
      }
      const { input } = command;
      if (input.bytes !== undefined && !Buffer.isBuffer(input.bytes)) {
        throw new Error("Fixture binary input lost its Buffer type");
      }
      if (preparation && preparedValue !== input.value) {
        throw new Error("Fixture execution requires its fully prepared nested input");
      }
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          context.admit("transaction");
          pause(input.transactionMarker, input.delayMs ?? 200);
          db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(
            input.bytes?.toString("utf8") ?? input.value,
          );
          return threadId;
        },
        {
          withCommit(commit) {
            context.admit("commit");
            pause(input.commitMarker, input.delayMs ?? 200);
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Fixture left an unsettled borrowed connection");
      }
    },
    close() {
      if (connectionInput?.cleanupAdmission) {
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: { kind: "fixture-cleanup" },
        });
      }
      const closeWriteValue = connectionInput?.closeWriteValue;
      if (closeWriteValue) {
        runSqliteImmediateTransactionSync(db, () => {
          context.admit("transaction");
          db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(closeWriteValue);
          context.admit("commit");
        });
      }
      if (connectionInput?.closeFailure) {
        throw new Error(connectionInput.closeFailure);
      }
    },
  };
}
