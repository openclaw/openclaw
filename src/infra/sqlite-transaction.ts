// Provides SQLite transaction helpers with nested savepoints.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

const transactionDepthByDatabase = new WeakMap<DatabaseSync, number>();
const transactionContext = new AsyncLocalStorage<{ depths: Map<DatabaseSync, number> }>();

const RETRYABLE_COMMIT_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
const MAX_COMMIT_ATTEMPTS = 8;

let nextSavepointId = 0;

function nextSavepointName(): string {
  nextSavepointId += 1;
  return `openclaw_tx_${nextSavepointId}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function assertSyncTransactionResult(value: unknown): void {
  if (isPromiseLike(value)) {
    throw new Error(
      "SQLite write transactions must be synchronous; Promise returns are not supported.",
    );
  }
}

function isRetryableCommitError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && RETRYABLE_COMMIT_ERROR_CODES.has(code);
}

function commitImmediateTransaction(db: DatabaseSync): void {
  for (const attempt of Array.from({ length: MAX_COMMIT_ATTEMPTS }, (_, index) => index + 1)) {
    try {
      db.exec("COMMIT");
      return;
    } catch (error) {
      if (!isRetryableCommitError(error) || attempt >= MAX_COMMIT_ATTEMPTS) {
        throw error;
      }
    }
  }
}

function abortImmediateTransaction(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // If rollback itself fails, close the handle so callers cannot keep using a
    // connection that may still hold an abandoned write transaction.
    try {
      db.close();
    } catch {
      // Preserve the original transaction error; close failure is secondary.
    }
  }
}

function getTransactionDepth(db: DatabaseSync): number {
  const contextDepth = transactionContext.getStore()?.depths.get(db);
  if (contextDepth !== undefined) {
    return contextDepth;
  }
  return transactionDepthByDatabase.get(db) ?? 0;
}

function setTransactionDepth(db: DatabaseSync, depth: number): void {
  const contextDepths = transactionContext.getStore()?.depths;
  if (contextDepths?.has(db)) {
    if (depth <= 0) {
      contextDepths.delete(db);
      return;
    }
    contextDepths.set(db, depth);
    return;
  }
  if (depth <= 0) {
    transactionDepthByDatabase.delete(db);
    return;
  }
  transactionDepthByDatabase.set(db, depth);
}

export function runSqliteImmediateTransactionSync<T>(db: DatabaseSync, operation: () => T): T {
  const depth = getTransactionDepth(db);
  if (depth > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    setTransactionDepth(db, depth + 1);
    try {
      const result = operation();
      assertSyncTransactionResult(result);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } finally {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw error;
    } finally {
      setTransactionDepth(db, depth);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  setTransactionDepth(db, 1);
  let transactionStillActive = true;
  let result: T;
  try {
    result = operation();
    assertSyncTransactionResult(result);
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }

  try {
    commitImmediateTransaction(db);
    transactionStillActive = false;
    return result;
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }
}

/** Run an async callback inside a SQLite immediate transaction. */
export async function runSqliteImmediateTransactionAsync<T>(
  db: DatabaseSync,
  operation: () => Promise<T> | T,
): Promise<T> {
  const depth = getTransactionDepth(db);
  if (depth > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    setTransactionDepth(db, depth + 1);
    try {
      const result = await operation();
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      } finally {
        db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      }
      throw error;
    } finally {
      setTransactionDepth(db, depth);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  let transactionStillActive = true;
  let result: T;
  const parentContext = transactionContext.getStore();
  const transactionDepths = new Map(parentContext?.depths);
  transactionDepths.set(db, 1);
  try {
    result = await transactionContext.run({ depths: transactionDepths }, async () => {
      return await operation();
    });
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }

  try {
    commitImmediateTransaction(db);
    transactionStillActive = false;
    return result;
  } catch (error) {
    try {
      abortImmediateTransaction(db);
      transactionStillActive = false;
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (!transactionStillActive) {
      setTransactionDepth(db, 0);
    }
  }
}
