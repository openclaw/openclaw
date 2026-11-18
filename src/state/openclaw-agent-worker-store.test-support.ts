import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
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

const PREPARATION_CLEANUP_GUARD_MS = 5_000;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForPreparation(gate: string) {
  // Host test signals cannot cross the worker's structured-clone API.
  return waitForFile(gate, AbortSignal.timeout(PREPARATION_CLEANUP_GUARD_MS));
}

export type AgentWorkerFixtureOperations = {
  inspect: { input: undefined | "wal_autocheckpoint"; output: number };
  failWorker: { input: "crash" | "exit"; output: never };
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
        receiptBroadcastName?: string;
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
  const receipts = connectionInput?.receiptBroadcastName
    ? new BroadcastChannel(connectionInput.receiptBroadcastName)
    : undefined;
  receipts?.unref();
  const enter = (marker: string, text: string) => {
    writeFileSync(marker, text);
    // Enqueue before native waits block this thread; the marker also precedes any result.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node BroadcastChannel has no targetOrigin.
    receipts?.postMessage({ source: marker, line: "entered" });
  };
  let codeLoaded = false;
  let preparedValue: string | undefined;
  if (connectionInput?.openMarker) {
    writeFileSync(connectionInput.openMarker, "factory entered");
  }
  const pause = (marker: string | undefined, milliseconds: number) => {
    if (marker) {
      enter(marker, "entered");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    }
  };
  return {
    [SQLITE_WORKER_PREPARE_COMMAND](commandType) {
      if (!preparation) {
        return undefined;
      }
      check(commandType === "append", "Fixture loader requires the nested command type");
      enter(preparation.codeMarker, "loading");
      return waitForPreparation(preparation.codeGate).then(() => {
        codeLoaded = true;
      });
    },
    prepare(command) {
      if (command.type === "failWorker") {
        return new Promise<never>(() => {
          setImmediate(() => {
            if (command.input === "exit") {
              process.exit(17);
            }
            throw new Error("Fixture worker crashed");
          });
        });
      }
      if (!preparation) {
        return undefined;
      }
      check(codeLoaded, "Fixture command preparation requires completed code loading");
      check(command.type === "append", "Fixture preparation requires an append command");
      enter(preparation.commandMarker, "preparing");
      return waitForPreparation(preparation.commandGate).then(() => {
        preparedValue = command.input.value;
      });
    },
    execute(command) {
      if (command.type === "failWorker") {
        throw new Error("Fixture failure must terminate the worker during preparation");
      }
      if (command.type === "inspect") {
        if (command.input === "wal_autocheckpoint") {
          return Number(db.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint);
        }
        const count = db.prepare("SELECT COUNT(*) AS count FROM worker_proof").get()?.count;
        check(typeof count === "number", "Fixture count is unavailable");
        return count;
      }
      const { input } = command;
      check(
        input.bytes === undefined || Buffer.isBuffer(input.bytes),
        "Fixture binary input lost its Buffer type",
      );
      check(
        !preparation || preparedValue === input.value,
        "Fixture execution requires its fully prepared nested input",
      );
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
      check(db.isOpen && !db.isTransaction, "Fixture left an unsettled borrowed connection");
    },
    close() {
      receipts?.close();
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
