import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  getOpenClawDatabaseMaintenanceScope,
  isOpenClawDatabaseMaintenanceResourceOwned,
  observeOpenClawDatabaseMaintenanceResource,
  type OpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

type RetirementIntent = {
  ordinary: boolean;
  isCurrent(): boolean;
  retire(): void;
};

export type StateDatabaseBorrowers = {
  references: Set<object>;
  retiring: boolean;
  cleanupComplete: boolean;
  retirement?: RetirementIntent;
  asyncRetirement?: {
    start(): void;
    close(): Promise<void>;
  };
};

/** The canonical cache supplies identity and custody; this owner manages its native references. */
export function createStateDatabaseRetainer(
  state: {
    borrowers: WeakMap<DatabaseSync, StateDatabaseBorrowers>;
    cachedDatabases: Map<string, OpenClawStateDatabase>;
  },
  operations: {
    assertOpen(pathname: string, ownership?: "cached-read"): void;
    capture(pathname: string): { assertCurrent(): void };
    retire(database: OpenClawStateDatabase, retireAdmission: boolean): void;
    retainFailed(database: OpenClawStateDatabase): void;
    ownRetirement(database: OpenClawStateDatabase, close: () => Promise<void>): () => void;
    touch(database: OpenClawStateDatabase): void;
  },
) {
  const admit = (pathname: string, ownership?: "cached-read") => {
    const scope = getOpenClawDatabaseMaintenanceScope();
    scope?.assertAdmission();
    operations.assertOpen(pathname, ownership);
    return scope;
  };
  // Only the synchronous entry points below can reach this already-admitted step.
  const retain = (
    database: OpenClawStateDatabase,
    scope: OpenClawDatabaseMaintenanceScope | undefined,
    readOnly = false,
  ) => {
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
    if (!readOnly) {
      observeOpenClawDatabaseMaintenanceResource(database.db);
    }
    state.borrowers.set(database.db, owner);
    const isCurrent = () =>
      !scope || isOpenClawDatabaseMaintenanceResourceOwned(database.db, scope);
    const retirement: RetirementIntent | undefined = readOnly
      ? undefined
      : {
          ordinary: scope === undefined,
          isCurrent,
          retire: () => {
            if (!isCurrent()) {
              owner.retiring = false;
              return;
            }
            operations.retire(database, scope === undefined);
          },
        };
    const reference = retainStateDatabaseReference({
      owner,
      retirement,
      stopBeforeRetirement: () => database.walMaintenance.stop(),
      retainFailedClose: () => operations.retainFailed(database),
      ownRetirement: (close) => operations.ownRetirement(database, close),
    });
    scope?.own(reference, "shared-references", () => reference.releaseAsync());
    return reference;
  };
  const findReadDatabase = (pathname: string, ownership?: "cached-read") => {
    const scope = admit(pathname, ownership);
    const database = state.cachedDatabases.get(path.resolve(pathname));
    return { database: database?.db.isOpen ? database : undefined, scope };
  };
  const retainReadReference = (
    database: OpenClawStateDatabase,
    scope: OpenClawDatabaseMaintenanceScope | undefined,
  ) => {
    const reference = retain(database, scope, true);
    const assertCurrent = () => {
      if (state.cachedDatabases.get(database.path) !== database || !database.db.isOpen) {
        throw new Error("Shared-state read lost its original native owner");
      }
    };
    return {
      assertCurrent,
      observe() {
        assertCurrent();
        // Failed schema admission must not transfer a maintenance-owned handle.
        observeOpenClawDatabaseMaintenanceResource(database.db);
      },
      release() {
        reference.release();
        operations.touch(database);
      },
    };
  };
  return {
    retain: (database: OpenClawStateDatabase) => retain(database, admit(database.path)),
    retainForIndependentRead(this: void, pathname: string, ownership?: "cached-read") {
      const { database, scope } = findReadDatabase(pathname, ownership);
      return database ? retainReadReference(database, scope) : undefined;
    },
    borrowForRead(this: void, pathname: string, ownership?: "cached-read") {
      const { database, scope } = findReadDatabase(pathname, ownership);
      if (!database) {
        return undefined;
      }
      if (database.db.isTransaction) {
        throw new Error("Asynchronous shared-state reads cannot run inside a native transaction");
      }
      return { database, ...retainReadReference(database, scope) };
    },
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

/** Preserve the requesting owner's retirement when the last reference is only a read pin. */
function retainStateDatabaseReference(params: {
  owner: StateDatabaseBorrowers;
  retirement?: RetirementIntent;
  stopBeforeRetirement(): Promise<void>;
  retainFailedClose(): void;
  ownRetirement(close: () => Promise<void>): () => void;
}): { release(): void; releaseAsync(): Promise<void> } {
  const { owner } = params;
  const reference = {};
  owner.references.add(reference);
  let released = false;
  const release = () => {
    if (released || owner.cleanupComplete) {
      released = true;
      return;
    }
    released = true;
    owner.references.delete(reference);
    if (owner.retirement && !owner.retirement.isCurrent()) {
      owner.retirement = undefined;
      owner.asyncRetirement = undefined;
      owner.retiring = false;
    }
    if (params.retirement?.isCurrent() && !owner.retirement?.ordinary) {
      owner.retirement = params.retirement;
    }
    if (owner.references.size > 0 || !owner.retirement) {
      return;
    }
    owner.retiring = true;
    if (owner.asyncRetirement) {
      owner.asyncRetirement.start();
      return;
    }
    try {
      owner.retirement.retire();
    } catch (error) {
      // The released reference transfers failed cleanup to the canonical cache.
      released = false;
      params.retainFailedClose();
      throw error;
    }
    owner.retirement = undefined;
  };
  return {
    release,
    async releaseAsync() {
      if (owner.cleanupComplete) {
        return;
      }
      const retirement =
        params.retirement?.isCurrent() && !owner.retirement?.ordinary
          ? params.retirement
          : owner.retirement;
      if (retirement?.isCurrent()) {
        owner.asyncRetirement ??= createAsyncStateDatabaseRetirement(params);
      }
      release();
      await owner.asyncRetirement?.close();
    },
  };
}

function createAsyncStateDatabaseRetirement(
  params: Pick<
    Parameters<typeof retainStateDatabaseReference>[0],
    "owner" | "stopBeforeRetirement" | "retainFailedClose" | "ownRetirement"
  >,
): NonNullable<StateDatabaseBorrowers["asyncRetirement"]> {
  const { owner } = params;
  const retained = {};
  let pending: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  const run = (): Promise<void> => {
    if (pending) {
      return pending;
    }
    if (owner.cleanupComplete || owner.references.size > (owner.references.has(retained) ? 1 : 0)) {
      return Promise.resolve();
    }
    if (!owner.retirement?.isCurrent()) {
      owner.references.delete(retained);
      owner.retirement = undefined;
      owner.asyncRetirement = undefined;
      owner.retiring = false;
      unregister?.();
      unregister = undefined;
      return Promise.resolve();
    }
    owner.retiring = true;
    // Keep physical custody across the join, including synchronous cache-close attempts.
    owner.references.add(retained);
    unregister ??= params.ownRetirement(close);
    pending = Promise.resolve()
      .then(async () => {
        await params.stopBeforeRetirement();
        const retirement = owner.retirement;
        if (retirement?.isCurrent()) {
          owner.references.delete(retained);
          retirement.retire();
        } else {
          owner.references.delete(retained);
          owner.retiring = false;
        }
        owner.retirement = undefined;
        owner.asyncRetirement = undefined;
        unregister?.();
        unregister = undefined;
      })
      .catch((error: unknown) => {
        owner.references.add(retained);
        params.retainFailedClose();
        throw error;
      });
    // A synchronous final release hands failures to the registered lifecycle resource.
    void pending.catch(() => {});
    return pending;
  };
  function close(): Promise<void> {
    const attempt = run();
    return attempt.catch((error: unknown) => {
      if (pending === attempt) {
        pending = undefined;
      }
      throw error;
    });
  }
  return { start: () => void run(), close };
}
