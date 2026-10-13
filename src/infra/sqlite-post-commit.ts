import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";

type PendingTransactionState = {
  /** Fence transferable readers immediately before the physical COMMIT. */
  prepareCommit?: () => void;
  commit: () => void;
  prepareObservers?: () => void;
  /** Retire facts on failed installation or unknown native outcome. Must not throw. */
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

function committedPublicationState(
  publication: SqliteCommittedPublication,
): PendingTransactionState {
  return {
    commit: publication.installFacts,
    prepareObservers: publication.installProjection,
    invalidate: publication.invalidate,
    rollback: () => {},
  };
}

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
export function publishSqliteCommittedState(
  publication: SqliteCommittedPublication | readonly SqliteCommittedPublication[],
): void {
  const publications = "installFacts" in publication ? [publication] : publication;
  installCommittedState(
    publications.map(committedPublicationState),
    publications.map((entry) => entry.notify),
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
      ...committedPublicationState(publication),
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
    prepareCommit: state.prepareCommit,
    commit: state.commit,
    prepareObservers: state.prepareObservers,
    invalidate: state.invalidate,
    rollback: state.rollback,
  });
  return true;
}

/** Tentative native writes stay private until their owner's final commit guard succeeds. */
export function prepareSqliteTransactionCommit(db: DatabaseSync): void {
  for (const state of pendingTransactionState.get(db) ?? []) {
    state.prepareCommit?.();
  }
}

function rollbackTransactionState(
  states: PendingTransactionState[],
  error: unknown,
  outcome: "rolled-back" | "unknown" = "rolled-back",
): void {
  const failures: unknown[] = [];
  for (const state of states.toReversed()) {
    try {
      if (outcome === "unknown" && state.invalidate) {
        state.invalidate(error);
      } else {
        state.rollback(error);
      }
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

/** Install a received commit without borrowing a reentrant native transaction's rollback scope. */
export function withSqliteCommittedPublications<T>(db: DatabaseSync, stage: () => T): T {
  const outerPublications = pendingPublications.get(db);
  const outerState = pendingTransactionState.get(db);
  const publications: Array<() => void> = [];
  const states: PendingTransactionState[] = [];
  pendingPublications.set(db, publications);
  pendingTransactionState.set(db, states);
  let result: T;
  try {
    result = stage();
  } catch (error) {
    rollbackTransactionState(states, error);
    throw error;
  } finally {
    if (outerPublications) {
      pendingPublications.set(db, outerPublications);
    } else {
      pendingPublications.delete(db);
    }
    if (outerState) {
      pendingTransactionState.set(db, outerState);
    } else {
      pendingTransactionState.delete(db);
    }
  }
  installCommittedState(states, publications);
  return result;
}

/** A lost transaction invalidates every savepoint's staged state and observers. */
export function discardSqliteTransactionState(
  db: DatabaseSync,
  error: unknown,
  outcome: "rolled-back" | "unknown" = "unknown",
): void {
  pendingPublications.get(db)?.splice(0);
  const rolledBackState = pendingTransactionState.get(db)?.splice(0) ?? [];
  pendingPublications.delete(db);
  pendingTransactionState.delete(db);
  rollbackTransactionState(rolledBackState, error, outcome);
}

/** Nested rollback restores staged state and discards observers; savepoints wait for outer commit. */
export function withSqlitePostCommitPublications<T>(db: DatabaseSync, transaction: () => T): T {
  const nested = db.isTransaction || pendingPublications.has(db);
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
