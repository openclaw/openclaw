import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";

type PendingTransactionState = {
  commit: () => void;
  prepareObservers?: () => void;
  /** Retire affected facts if installation fails after the durable COMMIT. Must not throw. */
  invalidate?: (error: unknown) => void;
  rollback: (error: unknown) => void;
};

const log = createSubsystemLogger("sqlite/publication");

export type SqliteCommittedPublication = {
  installFacts: () => void;
  installProjection?: () => void;
  invalidate: (error: unknown) => void;
  notify: () => void;
};

/**
 * Installation is synchronous, including failure fencing. Observers cannot turn a
 * committed write into a failed transaction or prevent another owner's receipt.
 */
function installCommittedState(
  states: readonly PendingTransactionState[],
  publications: readonly (() => void)[],
): void {
  const failures = new Map<PendingTransactionState, unknown>();
  const install = (state: PendingTransactionState, operation: (() => void) | undefined) => {
    try {
      operation?.();
    } catch (error) {
      failures.set(state, error);
    }
  };
  for (const state of states) {
    install(state, state.commit);
  }
  // Fence before projection consumers, and again after their installations: an
  // overlapping later delta must not accidentally certify an incomplete batch.
  const invalidate = () => {
    let fenced = true;
    for (const [state, error] of failures) {
      try {
        if (state.invalidate) {
          state.invalidate(error);
        } else {
          fenced = false;
        }
      } catch {
        fenced = false;
      }
    }
    return fenced;
  };
  invalidate();
  for (const state of states) {
    if (!failures.has(state)) {
      install(state, state.prepareObservers);
    }
  }
  const fenced = invalidate();
  if (failures.size > 0) {
    // Do not log callback errors: they may embed stored values or credentials.
    try {
      log.error("Committed SQLite facts could not be installed", { count: failures.size, fenced });
    } catch {
      // Diagnostics cannot change the durable outcome.
    }
  }
  if (!fenced) {
    return;
  }
  for (const publish of publications) {
    try {
      publish();
    } catch {
      try {
        log.error("SQLite post-commit notification failed");
      } catch {
        // Continue delivering the remaining committed publications.
      }
    }
  }
}

/** Use the same phase ordering for an already committed worker receipt. */
export function publishSqliteCommittedState(publication: SqliteCommittedPublication): void {
  installCommittedState(
    [
      {
        commit: publication.installFacts,
        prepareObservers: publication.installProjection,
        invalidate: publication.invalidate,
        rollback: () => {},
      },
    ],
    [publication.notify],
  );
}

/** Stage a complete owner publication; native savepoints share the outer commit. */
export function stageSqliteCommittedPublication(
  db: DatabaseSync,
  publication: SqliteCommittedPublication,
): boolean {
  if (
    !stageSqliteTransactionState(db, {
      stage: () => {},
      commit: publication.installFacts,
      prepareObservers: publication.installProjection,
      invalidate: publication.invalidate,
      rollback: () => {},
    })
  ) {
    return false;
  }
  deferSqlitePostCommitPublication(db, publication.notify);
  return true;
}

// One connection can cross native and transformed SDK module graphs mid-transaction.
const pendingPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.sqlitePostCommitPublications"),
  () => new WeakMap<DatabaseSync, Array<() => void>>(),
);
const pendingTransactionState = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTransactionState"),
  () => new WeakMap<DatabaseSync, PendingTransactionState[]>(),
);

/** Snapshots read within this managed transaction can still roll back. */
export function hasSqlitePostCommitScope(db: DatabaseSync): boolean {
  return pendingPublications.has(db);
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
 * Observer preparation follows every committed state update. All callbacks must not throw.
 */
export function stageSqliteTransactionState(
  db: DatabaseSync,
  state: PendingTransactionState & { stage: () => void },
): boolean {
  const pending = pendingTransactionState.get(db);
  if (!pending) {
    return false;
  }
  state.stage();
  pending.push({
    commit: state.commit,
    prepareObservers: state.prepareObservers,
    invalidate: state.invalidate,
    rollback: state.rollback,
  });
  return true;
}

function rollbackTransactionState(states: PendingTransactionState[], error: unknown): void {
  const failures: unknown[] = [];
  for (const state of states.toReversed()) {
    try {
      state.rollback(error);
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length > 0) {
    throw createSqliteLifecycleAggregateError(
      [error, ...failures],
      "SQLite transaction and rollback observers failed",
      error,
    );
  }
}

/** A lost transaction invalidates every savepoint's staged state and observers. */
export function discardSqliteTransactionState(db: DatabaseSync, error: unknown): void {
  pendingPublications.get(db)?.splice(0);
  const rolledBackState = pendingTransactionState.get(db)?.splice(0) ?? [];
  pendingPublications.delete(db);
  pendingTransactionState.delete(db);
  rollbackTransactionState(rolledBackState, error);
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
    rollbackTransactionState(rolledBackState, error);
    throw error;
  } finally {
    if (!nested) {
      pendingPublications.delete(db);
      pendingTransactionState.delete(db);
    }
  }
  if (!nested) {
    installCommittedState(transactionState ?? [], publications ?? []);
  }
  return result;
}
