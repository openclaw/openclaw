import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
  type HeartbeatOutcomeInput,
  type HeartbeatOutcomeRow,
} from "./heartbeat-outcome-store.kernel.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

export type HeartbeatOutcomeWorkerOperations = {
  persist: { input: HeartbeatOutcomeInput; output: undefined };
  claim: { input: { sessionKey: string; runId: string }; output: HeartbeatOutcomeRow | undefined };
};

/** Borrows the canonical agent connection for one admitted outcome operation. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<HeartbeatOutcomeWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      return runSqliteImmediateTransactionSync(
        db,
        () => {
          context.admit("transaction");
          return command.type === "persist"
            ? persistHeartbeatOutcomeInDatabase(db, command.input)
            : claimHeartbeatOutcomeRowInDatabase(db, command.input);
        },
        {
          operationLabel: `heartbeat.outcome.${command.type}`,
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: context.databasePath,
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Heartbeat outcome transaction did not settle");
      }
    },
    close() {},
  };
}
