import type { DatabaseSync } from "node:sqlite";
import type { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export type StateDatabaseBorrowers = {
  references: Set<object>;
  retiring: boolean;
  cleanupComplete: boolean;
  closeCoordinator?: ReturnType<typeof acquireStateDatabaseCoordinator>;
};

/** The canonical cache supplies identity and custody; this owner manages its native references. */
export function createStateDatabaseRetainer(
  state: {
    borrowers: WeakMap<DatabaseSync, StateDatabaseBorrowers>;
    cachedDatabases: Map<string, OpenClawStateDatabase>;
  },
  operations: {
    assertOpen(pathname: string): void;
    capture(pathname: string): { assertCurrent(): void };
    retire(database: OpenClawStateDatabase, retireAdmission: boolean): void;
    retainFailed(database: OpenClawStateDatabase): void;
  },
): (database: OpenClawStateDatabase) => { release(): void } {
  return (database) => {
    const scope = getOpenClawDatabaseMaintenanceScope();
    scope?.assertAdmission();
    operations.assertOpen(database.path);
    operations.capture(database.path).assertCurrent();
    if (state.cachedDatabases.get(database.path) !== database || !database.db.isOpen) {
      throw new Error("OpenClaw state database borrow requires its current canonical handle");
    }
    const owner: StateDatabaseBorrowers = state.borrowers.get(database.db) ?? {
      references: new Set<object>(),
      retiring: false,
      cleanupComplete: false,
    };
    if (owner.retiring) {
      throw new Error("OpenClaw state database native owner is retiring");
    }
    observeOpenClawDatabaseMaintenanceResource(database.db);
    state.borrowers.set(database.db, owner);
    const reference = retainStateDatabaseReference({
      owner,
      retire: () => {
        if (scope && !isOpenClawDatabaseMaintenanceResourceOwned(database.db, scope)) {
          owner.retiring = false;
          return;
        }
        operations.retire(database, scope === undefined);
      },
      retainFailedClose: () => operations.retainFailed(database),
    });
    scope?.own(reference, "shared-references", () => reference.release());
    return reference;
  };
}

export function assertStateDatabaseBorrowersReleased(
  owner: StateDatabaseBorrowers | undefined,
  pathname: string,
): void {
  if (owner?.references.size) {
    throw new Error(`OpenClaw state database still has active native borrowers: ${pathname}`);
  }
}

/** The cache supplies native retirement; each reference owns only its release protocol. */
function retainStateDatabaseReference(params: {
  owner: StateDatabaseBorrowers;
  retire(): void;
  retainFailedClose(): void;
}): { release(): void } {
  const { owner } = params;
  const reference = {};
  owner.references.add(reference);
  let released = false;
  return {
    release() {
      if (released || owner.cleanupComplete) {
        released = true;
        return;
      }
      owner.references.delete(reference);
      if (owner.references.size > 0) {
        released = true;
        return;
      }
      owner.retiring = true;
      try {
        params.retire();
      } catch (error) {
        // The released reference transfers failed cleanup to the canonical cache.
        params.retainFailedClose();
        throw error;
      }
      released = true;
    },
  };
}
