import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// One connection can cross native and transformed SDK module graphs mid-transaction.
const pendingPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePostCommitPublications"),
  () => new WeakMap<DatabaseSync, Array<() => void>>(),
);
const pendingTransactionState = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionState"),
  () => new WeakMap<DatabaseSync, Array<{ commit: () => void; rollback: () => void }>>(),
);

const postCommitLog = createSubsystemLogger("sqlite/post-commit");

function reportPostCommitObserverFailure(phase: string, error: unknown): void {
  postCommitLog.warn(`sqlite post-commit ${phase} failed`, {
    async: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Publications are non-throwing observers, never part of a durable transaction's result. */
export function deferSqlitePostCommitPublication(db: DatabaseSync, publish: () => void): boolean {
  const pending = pendingPublications.get(db);
  if (!pending) {
    return false;
  }
  pending.push(publish);
  return true;
}

/**
 * Stage private transaction-local state that publishes before fallible observers.
 * Stage, rollback, and commit callbacks must not throw.
 */
export function stageSqliteTransactionState(
  db: DatabaseSync,
  state: { stage: () => void; rollback: () => void; commit: () => void },
): boolean {
  const pending = pendingTransactionState.get(db);
  if (!pending) {
    return false;
  }
  state.stage();
  pending.push({ commit: state.commit, rollback: state.rollback });
  return true;
}

/** A lost transaction invalidates every savepoint's staged state and observers. */
export function discardSqliteTransactionState(db: DatabaseSync): void {
  pendingPublications.get(db)?.splice(0);
  const rolledBackState = pendingTransactionState.get(db)?.splice(0) ?? [];
  pendingPublications.delete(db);
  pendingTransactionState.delete(db);
  for (const state of rolledBackState.toReversed()) {
    try {
      state.rollback();
    } catch (error) {
      // One failing rollback must not strand the remaining staged state.
      reportPostCommitObserverFailure("rollback", error);
    }
  }
}

/** Nested rollback restores staged state and discards observers; savepoints wait for outer commit. */
export function withSqlitePostCommitPublications<T>(db: DatabaseSync, transaction: () => T): T {
  const nested = db.isTransaction;
  const publications = nested ? pendingPublications.get(db) : [];
  const transactionState = nested ? pendingTransactionState.get(db) : [];
  const publicationStart = publications?.length ?? 0;
  const stateStart = transactionState?.length ?? 0;
  if (!nested && publications && transactionState) {
    pendingPublications.set(db, publications);
    pendingTransactionState.set(db, transactionState);
  }
  let result: T;
  try {
    result = transaction();
  } catch (error) {
    publications?.splice(publicationStart);
    const rolledBackState = transactionState?.splice(stateStart) ?? [];
    for (const state of rolledBackState.toReversed()) {
      try {
        state.rollback();
      } catch (rollbackError) {
        // Preserve the transaction failure; a failing rollback must not mask
        // it or strand the remaining staged state.
        reportPostCommitObserverFailure("rollback", rollbackError);
      }
    }
    throw error;
  } finally {
    if (!nested) {
      pendingPublications.delete(db);
      pendingTransactionState.delete(db);
    }
  }
  if (!nested) {
    // The durable commit already succeeded. Each observer runs even when a
    // sibling fails, and observer failures never fail the committed result.
    for (const state of transactionState ?? []) {
      try {
        state.commit();
      } catch (error) {
        reportPostCommitObserverFailure("commit", error);
      }
    }
    for (const publish of publications ?? []) {
      try {
        publish();
      } catch (error) {
        reportPostCommitObserverFailure("publication", error);
      }
    }
  }
  return result;
}
