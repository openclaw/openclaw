import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { StagedAdmissionFact } from "./sqlite-database-admission-record.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sqliteNativeAdmissions"), () => ({
  operations: new WeakMap<
    DatabaseSync,
    { depth: number; facts: Map<string, StagedAdmissionFact>; reference: WeakRef<DatabaseSync> }
  >(),
  connections: new Set<WeakRef<DatabaseSync>>(),
}));

const finalizer = new FinalizationRegistry<WeakRef<DatabaseSync>>((reference) => {
  state.connections.delete(reference);
});

export function getSqliteNativeAdmissionFacts(
  database: DatabaseSync,
): Map<string, StagedAdmissionFact> | undefined {
  return state.operations.get(database)?.facts;
}

export function hasSqliteNativeAdmissionOperation(
  matches: (database: DatabaseSync) => boolean,
): boolean {
  for (const reference of state.connections) {
    const database = reference.deref();
    if (database && matches(database)) {
      return true;
    }
  }
  return false;
}

/** Callback-local facts may describe an implicit statement transaction that can still abort. */
export function beginSqliteDatabaseAdmissionOperation(database: DatabaseSync): () => void {
  const current = state.operations.get(database) ?? {
    depth: 0,
    facts: new Map(),
    reference: new WeakRef(database),
  };
  if (current.depth === 0) {
    state.connections.add(current.reference);
    finalizer.register(database, current.reference, current);
  }
  current.depth += 1;
  state.operations.set(database, current);
  return () => {
    current.depth -= 1;
    if (current.depth === 0) {
      // The schema owner captures committed facts after native settlement. Other callback
      // receipts must be validated outside the statement before they can become shared.
      state.operations.delete(database);
      state.connections.delete(current.reference);
      finalizer.unregister(current);
    }
  };
}
