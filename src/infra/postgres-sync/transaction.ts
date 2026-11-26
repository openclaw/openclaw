import { assertSyncTransactionResult, sqlPublicationAnchor } from "../sql-connection.js";
import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  discardSqliteTransactionState,
  prepareSqliteTransactionCommit,
  withSqlitePostCommitPublications,
} from "../sqlite-post-commit.js";
import { beginPostgresReadSnapshotScope } from "../sqlite-schema-facts.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { currentSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-settlement.js";
import { readSqliteWriteAdmissionServices } from "../sqlite-write-admission.js";
import {
  decodePostgresError,
  POSTGRES_REQUEST_TIMEOUT_MS,
  readPostgresSqlState,
} from "./protocol.js";

function assertPostgresOperationCurrent(): void {
  const scope = currentSqliteWorkerOperationAdmission.getStore();
  if (scope && (!scope.active || scope.owner.refusal)) {
    throw scope.owner.refusal ?? new Error("PostgreSQL worker operation is no longer active");
  }
}

type AdmissionTimeout = "lock_timeout" | "statement_timeout" | "transaction_timeout";

function beginPostgresWrite(db: PostgresSqlConnection): void {
  const services = readSqliteWriteAdmissionServices(db.anchor);
  const begin = "BEGIN ISOLATION LEVEL READ COMMITTED";
  const lock = `SELECT pg_advisory_xact_lock(${db.advisoryLockKey})`;
  if (!services) {
    db.exec(`${begin}; ${lock}`);
    return;
  }
  const started = performance.now();
  const settings = db
    .prepare(
      "SELECT name, setting FROM pg_settings WHERE name IN ('lock_timeout', 'statement_timeout', 'transaction_timeout')",
    )
    .all();
  const timeout = (name: AdmissionTimeout) =>
    Number(settings.find((row) => row.name === name)?.setting ?? 0);
  const lockTimeout = timeout("lock_timeout");
  const statementTimeout = timeout("statement_timeout");
  const transactionTimeout = timeout("transaction_timeout");
  const budget = [
    { name: "transaction_timeout", ms: transactionTimeout || Infinity },
    { name: "statement_timeout", ms: statementTimeout || Infinity },
    { name: "lock_timeout", ms: lockTimeout || Infinity },
    { name: "bridge request deadline", ms: POSTGRES_REQUEST_TIMEOUT_MS },
  ].reduce((first, next) => (first.ms <= next.ms ? first : next));
  const deadline = started + budget.ms;
  let lastLockError: Error | undefined;
  const assertBudget = () => {
    if (performance.now() < deadline) {
      return;
    }
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    if (budget.name === "lock_timeout" && lastLockError) {
      throw lastLockError;
    }
    if (budget.name === "bridge request deadline") {
      throw new Error(
        "PostgreSQL writer admission exceeded the bridge request deadline before the transaction began",
      );
    }
    if (budget.name === "transaction_timeout") {
      // Retire the rolled-back logical handle; the healthy pooled backend can be reused.
      db.close();
    }
    throw decodePostgresError({
      name: "error",
      code:
        budget.name === "transaction_timeout"
          ? "25P04"
          : budget.name === "lock_timeout"
            ? "55P03"
            : "57014",
      message: `PostgreSQL writer admission exceeded ${budget.name} before the transaction began`,
    });
  };
  const assertIdle = () => {
    assertPostgresOperationCurrent();
    if (!db.isOpen || db.isTransaction) {
      throw new Error("PostgreSQL writer admission requires an open idle connection");
    }
    assertBudget();
  };
  while (true) {
    assertIdle();
    try {
      db.exec(begin);
      assertBudget();
      if (transactionTimeout > 0) {
        const remaining = Math.max(1, Math.ceil(started + transactionTimeout - performance.now()));
        // PG17 only arms an inactive timer. Restore the visible GUC without
        // resetting that timer, so admission retries cannot extend the body budget.
        db.exec(
          `SET LOCAL transaction_timeout = 0; SET LOCAL transaction_timeout = '${remaining}ms'; SET LOCAL transaction_timeout = '${transactionTimeout}ms'`,
        );
      }
      assertBudget();
      const slice = Math.max(1, Math.min(25, Math.ceil(deadline - performance.now())));
      db.exec(`SET LOCAL lock_timeout = '${slice}ms'; ${lock}`);
      assertBudget();
      db.exec(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
      assertBudget();
      return;
    } catch (error) {
      if (!(error instanceof Error) || readPostgresSqlState(error) !== "55P03") {
        throw error;
      }
      // A failed advisory wait leaves an aborted transaction. Never service a
      // host-dependent worker while a contender request or transaction is live.
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      lastLockError = error;
      assertIdle();
      for (const service of services) {
        service();
        assertIdle();
      }
    }
  }
}

/** Multi-store fences release every acquired store before retrying a busy writer. */
export function tryReservePostgresTransactionSync(db: PostgresSqlConnection): boolean {
  db.exec("BEGIN ISOLATION LEVEL READ COMMITTED");
  return (
    db.prepare("SELECT pg_try_advisory_xact_lock(?) AS acquired").get(db.advisoryLockKey)
      ?.acquired === 1
  );
}

export function runPostgresTransactionSync<T>(
  db: PostgresSqlConnection,
  operation: () => T,
  options?: { withCommit?: (commit: () => void) => void },
  readOnly = false,
  reserved = false,
): T {
  assertPostgresOperationCurrent();
  const anchor = sqlPublicationAnchor(db);
  return withSqlitePostCommitPublications(anchor, () => {
    const nested = db.isTransaction && !reserved;
    let writeCommitted = false;
    let closeReadScope: (() => void) | undefined;
    try {
      if (nested) {
        db.exec("SAVEPOINT openclaw_tx_nested");
      } else if (!db.isTransaction) {
        if (readOnly) {
          db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        } else {
          beginPostgresWrite(db);
        }
      }
      if (readOnly && !nested) {
        closeReadScope = beginPostgresReadSnapshotScope(db);
      }
      const result = operation();
      assertSyncTransactionResult(result);
      if (nested) {
        db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
      } else {
        const commit = () => {
          assertPostgresOperationCurrent();
          if (!readOnly) {
            // Staged fences and predicates belong to physical COMMIT, never savepoint release.
            prepareSqliteTransactionCommit(db);
          }
          // End read snapshots without publishing the connection's COMMIT write receipt.
          db.exec(readOnly ? "ROLLBACK" : "COMMIT");
          writeCommitted = !readOnly;
        };
        if (options?.withCommit) {
          assertSyncTransactionResult(options.withCommit(commit));
        } else {
          commit();
        }
      }
      return result;
    } catch (error) {
      let unsafe = hasSqliteWorkerOutcomeUnknown(error) || writeCommitted;
      if (!unsafe) {
        try {
          if (nested) {
            db.exec("ROLLBACK TO SAVEPOINT openclaw_tx_nested");
            db.exec("RELEASE SAVEPOINT openclaw_tx_nested");
          } else if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
        } catch {
          unsafe = true;
        }
      }
      if (unsafe) {
        try {
          // Unknown or already committed writes cannot restore pre-write authority.
          // Drain every savepoint before close or an outer catch could publish stale facts.
          discardSqliteTransactionState(db, error, "unknown");
        } finally {
          try {
            db.close();
          } catch {
            // Retain the operation failure or its invalidation aggregate.
          }
        }
      }
      throw error;
    } finally {
      closeReadScope?.();
    }
  });
}

/**
 * Opens the read-only snapshot of runPostgresTransactionSync for a serialized worker task
 * whose reads span awaits. The returned function ends it.
 */
export function beginPostgresReadOnlyTransaction(db: PostgresSqlConnection): () => void {
  if (db.isTransaction) {
    throw new Error("A held PostgreSQL read snapshot requires an idle connection");
  }
  assertPostgresOperationCurrent();
  let closeReadScope: (() => void) | undefined;
  const end = () => {
    try {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    } catch {
      // An unjoinable rollback cannot leave a reusable connection behind.
      try {
        db.close();
      } catch {
        // The connection is already unusable.
      }
    } finally {
      closeReadScope?.();
    }
  };
  try {
    db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    closeReadScope = beginPostgresReadSnapshotScope(db);
  } catch (error) {
    end();
    throw error;
  }
  return end;
}
