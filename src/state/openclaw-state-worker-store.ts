import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  openSharedStateSqliteWorkerStore,
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  isSqliteWorkerStoreAvailable,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  getOpenClawStateDatabaseTerminalFailureAsync,
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

type StoreOperations = OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations;
type Store = SqliteWorkerStore<StoreOperations>;
type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;
const log = createSubsystemLogger("state/worker");

function createSharedStateWorkerOwner() {
  type Entry = {
    context: OpenClawStateWorkerContext;
    opening: Promise<Store | undefined>;
    existingOnly: boolean;
    store?: Store;
    bound?: boolean;
  };
  const stores = new Map<string, Entry>();
  const retiring = new Map<Entry, { pending?: Promise<void> }>();
  const matches = (entry: Entry, identity?: DatabasePathIdentity) =>
    identity === undefined || entry.context.admission.identity.key === identity.key;
  const forget = (entry: Entry) => {
    for (const [key, current] of stores) {
      if (current === entry) {
        stores.delete(key);
      }
    }
  };
  const hasPendingCleanup = (entry: Entry) =>
    hasUnclaimedSharedStateSqliteCleanup(entry.context.admission.databasePath);
  const retire = (entry: Entry) => {
    forget(entry);
    let attempt = retiring.get(entry);
    if (!attempt) {
      attempt = {};
      retiring.set(entry, attempt);
    }
    if (attempt.pending) {
      return attempt.pending;
    }
    const pending = entry.opening.then(
      (store) => store?.close(),
      () => closeUnclaimedSharedStateSqliteWorkers(entry.context.admission.databasePath),
    );
    attempt.pending = pending;
    const settled = () => {
      attempt.pending = undefined;
      if (!hasPendingCleanup(entry)) {
        retiring.delete(entry);
      }
    };
    void pending.then(settled, settled);
    return pending;
  };
  async function close(identity?: DatabasePathIdentity): Promise<void> {
    for (const entry of stores.values()) {
      if (matches(entry, identity)) {
        void retire(entry);
      }
    }
    const settled = await Promise.allSettled(
      [...retiring.keys()].filter((entry) => matches(entry, identity)).map(retire),
    );
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "Failed to close shared-state SQLite workers");
    }
  }
  registerOpenClawStateDatabaseAsyncResource({ close });
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened") {
      // Synchronous error eviction cannot await, but actor retirement remains
      // owned and every subsequent open or canonical drain joins it.
      if (!event.identity) {
        return;
      }
      void close(event.identity).catch((error: unknown) => {
        log.warn("Shared-state worker retirement failed", { path: event.path, error });
      });
    }
  });
  return {
    close,
    async retireFailedStore(store: Store): Promise<void> {
      await Promise.all([...stores.values()].filter((entry) => entry.store === store).map(retire));
    },
    async open(
      context: OpenClawStateWorkerContext,
      existingOnly = false,
    ): Promise<Store | undefined> {
      const { admission } = context;
      for (const [entry, attempt] of retiring) {
        if (matches(entry, admission.identity)) {
          if (!attempt.pending) {
            throw new Error(
              "Shared-state SQLite cleanup is pending; close the database before reopening",
            );
          }
          await attempt.pending;
        }
      }
      admission.assertCurrent();
      let entry =
        stores.get(admission.identity.key) ??
        [...stores.values()].find((candidate) => matches(candidate, admission.identity));
      if (!entry) {
        entry = {
          context,
          existingOnly,
          opening: openSharedStateSqliteWorkerStore<StoreOperations>(
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
              databasePath: admission.databasePath,
              existingOnly,
            },
            context,
            () => admission.assertCurrent(),
          ),
        };
        stores.set(admission.identity.key, entry);
        const admitted = entry;
        void entry.opening.catch(() => {
          forget(admitted);
          if (hasPendingCleanup(admitted) && !retiring.has(admitted)) {
            retiring.set(admitted, {});
          }
        });
      }
      const store = await entry.opening;
      admission.assertCurrent();
      if (!store) {
        forget(entry);
        return !existingOnly && entry.existingOnly ? this.open(context) : undefined;
      }
      entry.store = store;
      try {
        if (!entry.bound) {
          publishOpenClawStateDatabaseWorkerAdmission(entry.context.admission);
          entry.bound = true;
        }
      } catch (error) {
        try {
          await retire(entry);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Shared-state worker binding and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
      forget(entry);
      stores.set(admission.identity.key, entry);
      return store;
    },
  };
}

function owner() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sharedStateWorkerOwner"),
    createSharedStateWorkerOwner,
    (sharedOwner) => sharedOwner.close(),
  );
}

export async function executeOpenClawStateWorker<Key extends keyof OpenClawStateWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  const result = await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
  context.admission.assertCurrent();
  return result;
}

/** Retain the actor through its durable result and main-process reconciliation. */
export function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options: { existingOnly: true },
): Promise<T | undefined>;
export function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
): Promise<T>;
export async function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: { existingOnly: true },
): Promise<T | undefined> {
  const failure = await getOpenClawStateDatabaseTerminalFailureAsync(context);
  if (failure) {
    throw failure;
  }
  const store = await owner().open(context, options?.existingOnly);
  context.admission.assertCurrent();
  if (!store) {
    if (options?.existingOnly) {
      return undefined;
    }
    throw new Error("Canonical shared-state worker did not open its database");
  }
  return runWithOpenClawStateWorkerStore(store, context, operation);
}

/** Inspect the existing file without recursively admitting a domain operation. */
export async function inspectOpenClawStateDatabase(
  context: OpenClawStateWorkerContext,
  command: {
    type: "database.generationMatches";
    input: OpenClawStateWorkerInspectionOperations["database.generationMatches"]["input"];
  },
): Promise<boolean | undefined> {
  const store = await owner().open(context, true);
  context.admission.assertCurrent();
  if (!store) {
    return undefined;
  }
  return runWithOpenClawStateWorkerStore(store, context, (scope) =>
    scope.execute({
      type: "database.generationMatches",
      input: command.input,
    }),
  );
}

async function runWithOpenClawStateWorkerStore<T>(
  store: Store,
  context: OpenClawStateWorkerContext,
  operation: (scope: Pick<Store, "execute">) => Promise<T>,
): Promise<T> {
  const { admission } = context;
  try {
    return await runSqliteWorkerStoreOperation<StoreOperations, T>(store, operation, context, () =>
      admission.assertCurrent(),
    );
  } catch (error) {
    if (!isSqliteWorkerStoreAvailable(store)) {
      try {
        await owner().retireFailedStore(store);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Shared-state operation and retirement failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}
