import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";

function unexpectedDatabaseAccess(): never {
  throw new Error("Projection staging must not access the database driver");
}

/** Satisfy the complete driver contract without constructing or invoking a native database. */
export function createProjectionTransactionDatabase(): OpenClawStateDatabase {
  return {
    path: "projection-only",
    db: {
      isTransaction: true,
      get isOpen() {
        return unexpectedDatabaseAccess();
      },
      get limits() {
        return unexpectedDatabaseAccess();
      },
      aggregate: unexpectedDatabaseAccess,
      close: unexpectedDatabaseAccess,
      loadExtension: unexpectedDatabaseAccess,
      enableLoadExtension: unexpectedDatabaseAccess,
      enableDefensive: unexpectedDatabaseAccess,
      location: unexpectedDatabaseAccess,
      exec: unexpectedDatabaseAccess,
      function: unexpectedDatabaseAccess,
      setAuthorizer: unexpectedDatabaseAccess,
      open: unexpectedDatabaseAccess,
      serialize: unexpectedDatabaseAccess,
      deserialize: unexpectedDatabaseAccess,
      prepare: unexpectedDatabaseAccess,
      createTagStore: unexpectedDatabaseAccess,
      createSession: unexpectedDatabaseAccess,
      applyChangeset: unexpectedDatabaseAccess,
      [Symbol.dispose]: unexpectedDatabaseAccess,
    },
    walMaintenance: {
      checkpoint: unexpectedDatabaseAccess,
      reclaimFreePages: unexpectedDatabaseAccess,
      close: unexpectedDatabaseAccess,
    },
  };
}
