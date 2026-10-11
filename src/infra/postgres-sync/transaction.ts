import { assertSyncTransactionResult, assertTransactionUsable } from "../sql-connection.js";
import {
  beginSqliteDatabaseWrite,
  finishSqliteDatabaseWrite,
} from "../sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "../sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-settlement.js";
import type { PostgresSyncConnection } from "./connection.js";

function assertPostgresOperationCurrent(): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (scope && (!scope.active || scope.owner.refusal)) {
    throw scope.owner.refusal ?? new Error("PostgreSQL worker operation is no longer active");
  }
}

export function runPostgresTransactionSync<T>(
  db: PostgresSyncConnection,
  operation: () => T,
  options?: { withCommit?: (commit: () => void) => void },
  readOnly = false,
  reserved = false,
  admitWorker = true,
): T {
  assertTransactionUsable(db);
  assertPostgresOperationCurrent();
  return withSqlitePostCommitPublications(db.anchor, () => {
    const nested = db.isTransaction && !reserved;
    try {
      if (nested) {
        db.exec("SAVEPOINT openclaw_tx_nested");
      } else if (!db.isTransaction) {
        db.exec(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : `BEGIN ISOLATION LEVEL READ COMMITTED; SELECT pg_advisory_xact_lock(${db.advisoryLockKey})`,
        );
      }
      if (!nested && !readOnly && admitWorker && currentSqliteWorkerOperationAdmission.getStore()) {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      }
      const result = operation();
      assertSyncTransactionResult(result);
      assertTransactionUsable(db);
      if (nested) {
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      } else {
        const scope = currentSqliteWorkerOperationAdmission.getStore();
        if (!readOnly && scope?.active) {
          deferSqliteWorkerCommitReceipt(db.anchor, {});
        }
        const commit = () => {
          assertPostgresOperationCurrent();
          if (!readOnly && admitWorker && scope) {
            requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          }
          db.exec("COMMIT");
          if (!readOnly) {
            // The anchor carries the broker's cache identity. Only a confirmed
            // PostgreSQL commit may advance it; rollback must retain its token.
            beginSqliteDatabaseWrite(db.anchor);
            finishSqliteDatabaseWrite(db.anchor);
          }
        };
        if (options?.withCommit) {
          assertSyncTransactionResult(options.withCommit(commit));
        } else {
          commit();
        }
      }
      return result;
    } catch (error) {
      try {
        if (nested) {
          db.exec("ROLLBACK TO SAVEPOINT openclaw_tx_nested");
          db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
        } else if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
      } catch {
        // An unjoinable rollback cannot leave a reusable connection behind.
        try {
          db.close();
        } catch {
          // Retain the operation failure after retiring the connection.
        }
      }
      throw error;
    }
  });
}
