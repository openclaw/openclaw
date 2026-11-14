import { isDeepStrictEqual } from "node:util";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  openSharedStateSqliteWorkerStore,
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  isSqliteWorkerStoreAvailable,
  getSqliteWorkerActorIdentity,
  retireSqliteWorkerActor,
  SqliteWorkerError,
} from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  assertPublishedOpenClawStateDatabaseLifecycle,
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import type { OpenClawDatabaseMaintenanceScope } from "./openclaw-state-maintenance-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerCleanupOperations,
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerOperationOptions as OperationOptions,
} from "./openclaw-state-worker-contract.js";
import { createStateWorkerMemoryPressureSubscription } from "./openclaw-state-worker-memory-pressure.js";
import {
  assertOpenClawStateWorkerActorPath,
  assertOpenClawStateWorkerSchemaContext,
  captureOpenClawStateWorkerOpeningGuard,
} from "./openclaw-state-worker-operation.js";
import type { Entry, IdleTimer, Store } from "./openclaw-state-worker-store.types.js";

const log = createSubsystemLogger("state/worker");

function createSharedStateWorkerOwner() {
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("sharedStateStore");
  const stores = new Set<Entry>();
  const activeEntries = new Set<Entry>();
  const retiring = new Map<Entry, { pending?: Promise<void> }>();
  const refreshPressureSubscription = createStateWorkerMemoryPressureSubscription(
    () => stores.size > 0 || retiring.size > 0 || activeEntries.size > 0,
    retireIdleWorkers,
  );
  const matches = (entry: Entry, identity?: DatabasePathIdentity) =>
    identity === undefined || entry.context.admission.identity.key === identity.key;
  const hasActiveActorOperations = (entry: Entry) =>
    [...activeEntries].some((active) =>
      entry.actor ? active.actor === entry.actor : active === entry,
    );
  const clearIdleRetirement = (entry: Entry) => {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  };
  const hasPendingCleanup = (entry: Entry) =>
    entry.cleanup?.pending ??
    (!entry.context.maintenanceScope &&
      hasUnclaimedSharedStateSqliteCleanup(entry.context.admission.databasePath));
  const retire = (entry: Entry) => {
    clearIdleRetirement(entry);
    stores.delete(entry);
    let attempt = retiring.get(entry);
    if (!attempt) {
      attempt = {};
      retiring.set(entry, attempt);
    }
    refreshPressureSubscription();
    if (attempt.pending) {
      return attempt.pending;
    }
    const pending = entry.store
      ? entry.store.close()
      : entry.opening.then(
          (store) => store?.close(),
          () =>
            entry.cleanup
              ? entry.cleanup.close()
              : entry.context.maintenanceScope
                ? undefined
                : closeUnclaimedSharedStateSqliteWorkers(entry.context.admission.databasePath),
        );
    attempt.pending = pending;
    const settled = () => {
      attempt.pending = undefined;
      if (!hasPendingCleanup(entry)) {
        retiring.delete(entry);
      }
      refreshPressureSubscription();
    };
    void pending.then(settled, settled);
    return pending;
  };
  const scheduleIdleRetirement = (entry: Entry) => {
    if (
      entry.activeOperations !== 0 ||
      entry.idleTimer ||
      entry.context.maintenanceScope ||
      !entry.store ||
      !stores.has(entry)
    ) {
      return;
    }
    const timer: IdleTimer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        if (entry.idleTimer !== timer || entry.activeOperations !== 0 || !stores.has(entry)) {
          return;
        }
        entry.idleTimer = undefined;
        void retire(entry).catch((error: unknown) => {
          log.warn("Idle shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
      }, SQLITE_IDLE_HANDLE_TTL_MS),
    );
    entry.idleTimer = timer;
    timer.unref?.();
  };
  const retireAfterFailure = async (
    entry: Entry,
    error: unknown,
    stage: "admission" | "binding",
  ): Promise<never> => {
    try {
      await retire(entry);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Shared-state worker ${stage} and cleanup failed`,
        { cause: cleanupError },
      );
    }
    throw error;
  };
  const retainOperation = (store: Store, onNativeLost?: () => void) => {
    const entry = [...stores].find((candidate) => candidate.store === store);
    if (!entry) {
      throw new Error("Shared-state worker operation lost its actor owner");
    }
    clearIdleRetirement(entry);
    entry.activeOperations += 1;
    activeEntries.add(entry);
    if (onNativeLost) {
      entry.nativeLostListeners.add(onNativeLost);
      if (!isSqliteWorkerStoreAvailable(store)) {
        onNativeLost();
      }
    }
    let released = false;
    return () => {
      if (released) {
        return undefined;
      }
      released = true;
      if (onNativeLost) {
        entry.nativeLostListeners.delete(onNativeLost);
      }
      entry.activeOperations -= 1;
      if (entry.activeOperations === 0) {
        activeEntries.delete(entry);
      }
      refreshPressureSubscription();
      if (
        stores.has(entry) &&
        !isSqliteWorkerStoreAvailable(store) &&
        !hasActiveActorOperations(entry)
      ) {
        // Co-users may await each other's callbacks across maintenance scopes.
        // Only their final release can join actor-wide client closure.
        const pending = entry.actor ? retireActor(entry.actor) : retire(entry);
        void pending.catch((error: unknown) => {
          log.warn("Shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
        return pending;
      }
      scheduleIdleRetirement(entry);
      return undefined;
    };
  };
  const retireActor = (actor: object): Promise<void> => {
    // The broker seals all clients and owns their command and native-close settlement.
    const pending = retireSqliteWorkerActor(actor);
    for (const entry of new Set([...stores, ...retiring.keys()])) {
      if (entry.actor === actor) {
        void retire(entry);
      }
    }
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
    refreshPressureSubscription();
    if (errors.length) {
      throw new AggregateError(errors, "Failed to close shared-state SQLite workers");
    }
  }
  registerOpenClawStateDatabaseAsyncResource({ phase: "after-resources", close });
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
  function retireIdleWorkers() {
    for (const entry of stores) {
      void runInDetachedAsyncContext(() => retireIdle(entry))?.catch((error: unknown) => {
        log.warn("Idle shared-state worker retirement failed", {
          path: entry.context.admission.databasePath,
          error,
        });
      });
    }
  }
  const retireIdle = (entry: Entry) =>
    entry.idleTimer &&
    entry.store &&
    stores.has(entry) &&
    !entry.context.maintenanceScope &&
    !hasActiveActorOperations(entry)
      ? retire(entry)
      : undefined;
  return {
    close,
    retainOperation,
    // Source and bundled callers must share the owner's backend URL.
    async openCleanup(
      databasePath: string,
      context: SqliteWorkerStateContext,
      assertOwned: () => void,
      identity: DatabasePathIdentity,
      maintenanceScope?: OpenClawDatabaseMaintenanceScope,
    ) {
      const expectedIdentity = { ...identity };
      assertOwned();
      if (!expectedIdentity.key.startsWith("file:")) {
        return undefined;
      }
      const assertCurrent = () => {
        assertOwned();
        for (const entry of activeEntries) {
          if (
            matches(entry, expectedIdentity) &&
            entry.store &&
            !isSqliteWorkerStoreAvailable(entry.store)
          ) {
            // A retained callback may itself need cleanup before it can settle.
            throw new SqliteWorkerError(
              "Shared-state cleanup is waiting for accepted operations to settle",
              "unavailable",
            );
          }
        }
      };
      assertCurrent();
      for (const entry of new Set([...stores, ...retiring.keys()])) {
        if (
          (stores.has(entry) || retiring.has(entry)) &&
          matches(entry, expectedIdentity) &&
          entry.store &&
          !isSqliteWorkerStoreAvailable(entry.store)
        ) {
          assertCurrent();
          await (entry.actor ? retireActor(entry.actor) : retire(entry));
          assertCurrent();
        }
      }
      return openSharedStateSqliteWorkerStore<OpenClawStateWorkerCleanupOperations>(
        {
          ...captureRuntimeWorkerSource(moduleUrl),
          databasePath,
          existingOnly: true,
          admission: {
            identity: expectedIdentity.key,
            birthtime: expectedIdentity.birthtime,
            assertCurrent,
          },
        },
        context,
        assertCurrent,
        {
          cleanupAccess: maintenanceScope && {
            assertDatabaseAccess: maintenanceScope.assertCleanupDatabaseAccess,
          },
        },
      );
    },
    async open(
      context: OpenClawStateWorkerContext,
      options: Omit<OperationOptions, "createAdmission"> = {},
    ): Promise<Store | undefined> {
      const { existingOnly = false, assertCurrent, signal } = options;
      const { admission } = context;
      const wait = <T>(pending: Promise<T>) => racePromiseWithAbortSignal(pending, signal);
      const source = captureRuntimeWorkerSource(moduleUrl);
      const assertAdmission = () => {
        signal?.throwIfAborted();
        admission.assertCurrent();
        assertCurrent?.();
      };
      assertAdmission();
      assertOpenClawStateWorkerSchemaContext(context);
      for (const candidate of new Set([...stores, ...retiring.keys()])) {
        if (!matches(candidate, admission.identity)) {
          continue;
        }
        if (
          stores.has(candidate) &&
          (candidate.context.existingSchemaPath !== context.existingSchemaPath ||
            !isDeepStrictEqual(
              candidate.context.gatewayServiceInstallation,
              context.gatewayServiceInstallation,
            ) ||
            candidate.source.moduleUrl.href !== source.moduleUrl.href)
        ) {
          // A nested caller cannot join closure of the client scope retaining its
          // outer lease. Preserve policy refusal without waiting on that scope.
          if (hasActiveActorOperations(candidate)) {
            throw new Error(
              "Shared-state worker policy changed while its actor is in use; close its leases first",
            );
          }
          // Cleanup clients can still retain the actor after this entry closes.
          // Retire every client before reopening under the new policy.
          await wait(candidate.actor ? retireActor(candidate.actor) : retire(candidate));
          assertAdmission();
        }
      }
      for (const [retiringEntry, attempt] of retiring) {
        if (
          matches(retiringEntry, admission.identity) &&
          retiringEntry.context.maintenanceScope === context.maintenanceScope
        ) {
          if (hasActiveActorOperations(retiringEntry)) {
            throw new Error(
              "Shared-state worker is retiring while its actor is in use; close its leases first",
            );
          }
          if (!attempt.pending) {
            // Another retained owner may have completed the failed admission's cleanup.
            if (!hasPendingCleanup(retiringEntry)) {
              retiring.delete(retiringEntry);
              refreshPressureSubscription();
              continue;
            }
            throw new Error(
              "Shared-state SQLite cleanup is pending; close the database before reopening",
            );
          }
          try {
            await wait(attempt.pending);
          } catch (error) {
            if (retiring.get(retiringEntry) === attempt) {
              throw error;
            }
          }
          assertAdmission();
        }
      }
      assertAdmission();
      let entry = [...stores].find(
        (candidate) =>
          matches(candidate, admission.identity) &&
          candidate.context.maintenanceScope === context.maintenanceScope &&
          candidate.context.existingSchemaPath === context.existingSchemaPath &&
          isDeepStrictEqual(
            candidate.context.gatewayServiceInstallation,
            context.gatewayServiceInstallation,
          ),
      );
      const ownsOpening = !entry;
      if (!entry) {
        const openingGuard = captureOpenClawStateWorkerOpeningGuard(context);
        const nativeLostListeners = new Set<() => void>();
        const open = () =>
          openingGuard.run(() =>
            openSharedStateSqliteWorkerStore<OpenClawStateWorkerOperations>(
              {
                ...source,
                databasePath: admission.databasePath,
                existingOnly,
              },
              context,
              openingGuard.assertCurrent,
              {
                maintenanceScope: context.maintenanceScope,
                // Opening binds the captured file; later commands retain their own authority.
                ...(existingOnly && admission.identity.key.startsWith("file:")
                  ? { createAdmission: openingGuard.createAdmission }
                  : {}),
                retireIdle: retireIdle.bind(undefined, admitted),
                retainCleanup: (cleanup) => {
                  admitted.cleanup = cleanup;
                },
                // Bind only the listener set so the broker does not retain the opening caller.
                onNativeLost: notifyListeners.bind(
                  undefined,
                  nativeLostListeners,
                  undefined,
                  undefined,
                ),
              },
            ),
          );
        const admitted: Entry = {
          source,
          context,
          existingOnly,
          nativeLostListeners,
          activeOperations: 0,
          opening: Promise.resolve(undefined),
        };
        // Initialize the entry before binding retirement without retaining the opening caller.
        // Maintenance may already be draining an accepted callback, so keep its live admission.
        admitted.opening = context.maintenanceScope ? open() : runInDetachedAsyncContext(open);
        entry = admitted;
        admitted.opening = admitted.opening.then((store) => {
          if (store) {
            admitted.store = store;
            admitted.actor = getSqliteWorkerActorIdentity(store);
            scheduleIdleRetirement(admitted);
          } else {
            stores.delete(admitted);
            refreshPressureSubscription();
          }
          return store;
        });
        stores.add(entry);
        refreshPressureSubscription();
        context.maintenanceScope?.own(entry, "shared-resources", () => retire(admitted));
        void entry.opening.catch(() => {
          stores.delete(admitted);
          if (hasPendingCleanup(admitted) && !retiring.has(admitted)) {
            retiring.set(admitted, {});
          }
          refreshPressureSubscription();
        });
      }
      // Other callers may leave this wait; the opening owner still joins its native settlement.
      const store = await (ownsOpening ? entry.opening : wait(entry.opening));
      try {
        admission.assertCurrent();
      } catch (error) {
        return retireAfterFailure(entry, error, "admission");
      }
      signal?.throwIfAborted();
      assertCurrent?.();
      if (!store) {
        return !existingOnly && entry.existingOnly
          ? this.open(context, { ...options, existingOnly: false })
          : undefined;
      }
      if (!stores.has(entry)) {
        return this.open(context, options);
      }
      clearIdleRetirement(entry);
      if (!isSqliteWorkerStoreAvailable(store) && !hasActiveActorOperations(entry)) {
        await wait(entry.actor ? retireActor(entry.actor) : retire(entry));
        return this.open(context, options);
      }
      try {
        if (!entry.bound) {
          publishOpenClawStateDatabaseWorkerAdmission(
            entry.context.admission,
            getSqliteWorkerActorIdentity(store).identity,
          );
          entry.bound = true;
        }
      } catch (error) {
        return retireAfterFailure(entry, error, "binding");
      }
      if (entry.actor) {
        assertOpenClawStateWorkerActorPath(entry.actor);
      }
      stores.delete(entry);
      stores.add(entry);
      return store;
    },
  };
}

export function getOpenClawStateWorkerOwner() {
  // The owner registers with and publishes into the cache that created it. A
  // retired generation must neither install its owner nor drive the current one.
  assertPublishedOpenClawStateDatabaseLifecycle();
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sharedStateWorkerOwner"),
    createSharedStateWorkerOwner,
  );
}
