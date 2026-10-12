import {
  claimHeartbeatOutcomeRowInDatabase,
  persistHeartbeatOutcomeInDatabase,
  type HeartbeatOutcomeInput,
  type HeartbeatOutcomeRow,
} from "./heartbeat-outcome-store.kernel.js";
import { assertTransactionUsable, runSqliteSingleStatementSync } from "./sqlite-transaction.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "./sqlite-worker-database-context.js";

export type HeartbeatOutcomeWorkerOperations = {
  persist: { input: HeartbeatOutcomeInput; output: undefined };
  claim: { input: { sessionKey: string; runId: string }; output: HeartbeatOutcomeRow | undefined };
};

/** Borrows the canonical agent connection for one admitted outcome operation. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<HeartbeatOutcomeWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      context.admit("transaction");
      context.admit("commit");
      return runSqliteSingleStatementSync(db, () =>
        command.type === "persist"
          ? persistHeartbeatOutcomeInDatabase(db, command.input)
          : claimHeartbeatOutcomeRowInDatabase(db, command.input),
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
