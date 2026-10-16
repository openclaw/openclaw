import {
  assertSyncTransactionResult,
  assertPostgresTransactionUsable,
  sqlPublicationAnchor,
} from "../sql-connection.js";
import type { PostgresSqlConnection } from "../sql-connection.js";
import { withSqlitePostCommitPublications } from "../sqlite-post-commit.js";
import { deferSqliteWorkerCommitReceipt } from "../sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-settlement.js";

function assertPostgresOperationCurrent(): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (scope && (!scope.active || scope.owner.refusal)) {
    throw scope.owner.refusal ?? new Error("PostgreSQL worker operation is no longer active");
  }
}

export function runPostgresTransactionSync<T>(
  db: PostgresSqlConnection,
  operation: () => T,
  options?: { withCommit?: (commit: () => void) => void },
  readOnly = false,
  reserved = false,
): T {
  assertPostgresTransactionUsable(db);
  assertPostgresOperationCurrent();
  const anchor = sqlPublicationAnchor(db);
  return withSqlitePostCommitPublications(anchor, () => {
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
      const result = operation();
      assertSyncTransactionResult(result);
      assertPostgresTransactionUsable(db);
      if (nested) {
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      } else {
        const scope = currentSqliteWorkerOperationAdmission.getStore();
        if (!readOnly && scope?.active && !scope.owner.pendingReceipts?.has(anchor)) {
          // A domain's staged receipt already settles this commit with its typed facts.
          deferSqliteWorkerCommitReceipt(anchor, {});
        }
        const commit = () => {
          assertPostgresOperationCurrent();
          // End read snapshots without publishing the connection's COMMIT write receipt.
          db.exec(readOnly ? "ROLLBACK" : "COMMIT");
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
