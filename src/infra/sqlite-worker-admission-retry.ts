import type { EngineConnection } from "./sql-connection.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";
import { SqliteWorkerAdmissionTimeoutError } from "./sqlite-worker-contract.js";
import { currentSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-settlement.js";

// Release the writer before the serving Gateway's five-second lock budget expires.
export const SQLITE_WORKER_ADMISSION_DEADLINE_MS = 1_000;

/** The operation must finish rollback before a timed-out attempt can be replayed. */
export function retrySqliteWorkerAdmission<T>(
  operation: () => T,
  {
    maxAttempts,
    database,
    exhaustedMessage,
  }: {
    maxAttempts: number;
    database?: EngineConnection;
    exhaustedMessage?: string;
  },
): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof SqliteWorkerAdmissionTimeoutError)) {
        throw error;
      }
      if (database) {
        assertTransactionUsable(database);
        if (!database.isOpen || database.isTransaction) {
          throw error;
        }
      }
      if (attempt >= maxAttempts) {
        throw exhaustedMessage ? new Error(exhaustedMessage, { cause: error }) : error;
      }
      const owner = currentSqliteWorkerOperationAdmission.getStore()?.owner;
      if (owner?.refusal === error) {
        delete owner.refusal;
      }
    }
  }
}
