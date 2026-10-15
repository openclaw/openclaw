import type { Result } from "@openclaw/normalization-core/result";
import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
import { isSqliteWorkerError, type SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  prepareSessionProgressCardWrite,
  writePreparedSessionProgressCard,
} from "./progress-card-store.js";

export type ProgressCardWorkerOperations = {
  put: {
    input: Parameters<typeof prepareSessionProgressCardWrite>[0] & { sessionKey: string };
    output: Result<
      ReturnType<typeof writePreparedSessionProgressCard>,
      OpenClawStateWorkerErrorPayload
    >;
  };
};

/** Borrows the canonical agent writer connection; reset shares its row kernel. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<ProgressCardWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      const input = prepareSessionProgressCardWrite(command.input);
      try {
        const value = runSqliteWorkerTransactionSync(
          context,
          () => writePreparedSessionProgressCard(db, command.input.sessionKey, input),
          {
            databaseLabel: context.databasePath,
            operationLabel: "progress-card.put",
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          },
        );
        return { ok: true, value };
      } catch (error) {
        // The broker retains the original host error for a refused grant.
        if (isSqliteWorkerError(error, "closed")) {
          throw error;
        }
        // An uncertain native outcome stays with the broker and never becomes a replayable refusal.
        assertTransactionUsable(db);
        if (!db.isOpen || db.isTransaction) {
          throw error;
        }
        const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
        if (!failure) {
          throw error;
        }
        return { ok: false, error: failure };
      }
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Progress-card transaction did not settle");
      }
    },
    close() {},
  };
}
