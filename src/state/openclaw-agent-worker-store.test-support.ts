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

export type AgentWorkerFixtureOperations = {
  append: {
    input: { value: string; transactionMarker?: string; commitMarker?: string; delayMs?: number };
    output: number;
  };
};

export function bindSqliteWorkerBackend(
  connectionInput:
    | {
        openMarker?: string;
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
      writeFileSync(preparation.commandMarker, "preparing");
      return waitForFile(preparation.commandGate, 5000).then(() => {
        preparedValue = command.input.value;
      });
    },
    execute({ input }) {
      if (preparation && preparedValue !== input.value) {
        throw new Error("Fixture execution requires its fully prepared nested input");
      }
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          context.admit("transaction");
          pause(input.transactionMarker, input.delayMs ?? 200);
          db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(input.value);
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
    close() {},
  };
}
