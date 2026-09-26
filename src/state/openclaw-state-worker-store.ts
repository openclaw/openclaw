import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
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
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  publishOpenClawStateDatabaseWorkerAdmission,
  getOpenClawStateDatabaseTerminalFailureAsync,
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
  recordOpenClawStateDatabaseOpenFailure,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { findOpenClawStateDatabaseFailure } from "./openclaw-state-db-failure.js";
import {
  getExistingOpenClawStateSchemaPath,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
  OpenClawStateWorkerCleanupOperations,
  OpenClawStateWorkerOperationOptions as OperationOptions,
} from "./openclaw-state-worker-contract.js";
import { hydrateOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import {
  captureOpenClawStateWorkerOpeningGuard,
  runWithCapturedWorkerContext,
  runWithOpenClawStateWorkerStore,
} from "./openclaw-state-worker-operation.js";
import type {
  ActorRetirement,
  DomainScope,
  Entry,
  IdleTimer,
  Store,
  StoreOperations,
} from "./openclaw-state-worker-store.types.js";

const log = createSubsystemLogger("state/worker");
const SHARED_STATE_WORKER_IDLE_INSPECT_MS = 60_000;

function createSharedStateWorkerOwner() {
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("sharedStateStore");
  const stores = new Set<Entry>();
  const activeEntries = new Set<Entry>();
  const retiring = new Map<Entry, { pending?: Promise<void>; actorSettlement?: Promise<void> }>();
  const retiringActors = new Map<object, ActorRetirement>();
  const memoryPressure = channel("openclaw.memory.critical");
  let pressureSubscribed = false;
  const refreshPressureSubscription = () => {
    const hasCustody =
      stores.size > 0 || retiring.size > 0 || retiringActors.size > 0 || activeEntries.size > 0;
    if (hasCustody === pressureSubscribed) {
      return;
    }
    pressureSubscribed = hasCustody;
    if (hasCustody) {
      memoryPressure.subscribe(retireIdleWorkers);
    } else {
      memoryPressure.unsubscribe(retireIdleWorkers);
    }
  };
  const matches = (entry: Entry, identity?: DatabasePathIdentity) =>
    identity === undefined || entry.context.admission.identity.key === identity.key;
  const hasActiveActorOperations = (entry: Entry) =>
    [...activeEntries].some((active) =>
      entry.actor ? active.actor === entry.actor : active === entry,
    );
  const clearIdleRetirement = (entry: Entry) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
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
    if (entry.actor && retiringActors.has(entry.actor)) {
      return retireActor(entry.actor, entry.context.admission.identity);
    }
    const pending = (
      entry.store
        ? entry.store.close()
        : entry.opening.then(
            (store) => store?.close(),
            () =>
              entry.cleanup
                ? entry.cleanup.close()
                : entry.context.maintenanceScope
                  ? undefined
                  : closeUnclaimedSharedStateSqliteWorkers(entry.context.admission.databasePath),
          )
    ).catch(async (error: unknown) => {
      if (!attempt.actorSettlement) {
        throw error;
      }
      // Adoption transfers cleanup settlement, not the operation's original failure.
      await attempt.actorSettlement;
    });
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
    const store = entry.store;
    const generation = entry.operationGeneration;
    const deadline = performance.now() + SQLITE_IDLE_HANDLE_TTL_MS;
    const arm = (delay: number, inspect: boolean) => {
      const isCurrentIdle = () =>
        entry.idleTimer === timer &&
        entry.operationGeneration === generation &&
        entry.activeOperations === 0 &&
        stores.has(entry);
      const settle = async () => {
        if (!isCurrentIdle()) {
          return;
        }
        let healthy = false;
        if (inspect) {
          try {
            // This idle generation owns retirement while foreground callbacks may remain active.
            healthy =
              (await runWithCapturedWorkerContext(entry.context, () =>
                runSqliteWorkerStoreOperation(
                  store,
                  (scope) => scope.execute({ type: "database.inspectIdle", input: undefined }),
                  entry.context,
                  () => {
                    entry.context.admission.assertCurrent();
                    if (!isCurrentIdle()) {
                      throw new Error("Shared-state worker resumed before idle inspection");
                    }
                  },
                ),
              )) === "healthy" && isSqliteWorkerStoreAvailable(store);
            entry.context.admission.assertCurrent();
          } catch {
            // Unavailable inspection cannot justify retaining a potentially pinned native reader.
            healthy = false;
          }
        }
        if (!isCurrentIdle()) {
          return;
        }
        entry.idleTimer = undefined;
        const remaining = deadline - performance.now();
        if (healthy && remaining > 0) {
          // Inspection is maintenance, not activity: retain the original real-operation deadline.
          arm(remaining, false);
        } else {
          await retire(entry);
        }
      };
      const timer: IdleTimer = runInDetachedAsyncContext(() =>
        setTimeout(() => {
          void settle().catch((error: unknown) => {
            log.warn("Idle shared-state worker retirement failed", {
              path: entry.context.admission.databasePath,
              error,
            });
          });
        }, delay),
      );
      entry.idleTimer = timer;
      timer.unref?.();
    };
    arm(SHARED_STATE_WORKER_IDLE_INSPECT_MS, true);
  };
  const retainOperation = (store: Store) => {
    const entry = [...stores].find((candidate) => candidate.store === store);
    if (!entry) {
      throw new Error("Shared-state worker operation lost its actor owner");
    }
    clearIdleRetirement(entry);
    entry.operationGeneration += 1;
    entry.activeOperations += 1;
    activeEntries.add(entry);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
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
        const pending = entry.actor
          ? retireActor(entry.actor, entry.context.admission.identity)
          : retire(entry);
        void pending.catch((error: unknown) => {
          log.warn("Shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
        return;
      }
      scheduleIdleRetirement(entry);
    };
  };
  const retainActorSettlement = (attempt: ActorRetirement, pending: Promise<void>) => {
    for (const entry of attempt.entries) {
      const closing = retiring.get(entry);
      if (closing) {
        // Keep this join after the completed actor leaves the registry.
        closing.actorSettlement = pending;
      }
    }
    return pending;
  };
  const retireActor = (actor: object, identity: DatabasePathIdentity): Promise<void> => {
    let attempt = retiringActors.get(actor);
    if (!attempt) {
      attempt = { identity, entries: new Set() };
      retiringActors.set(actor, attempt);
    }
    for (const entry of [...stores, ...retiring.keys()]) {
      if (entry.actor === actor) {
        attempt.entries.add(entry);
        clearIdleRetirement(entry);
        stores.delete(entry);
      }
    }
    refreshPressureSubscription();
    if (attempt.pending) {
      return retainActorSettlement(attempt, attempt.pending);
    }
    const current = attempt;
    const complete = () => {
      for (const entry of current.entries) {
        clearIdleRetirement(entry);
        stores.delete(entry);
        retiring.delete(entry);
      }
      retiringActors.delete(actor);
      refreshPressureSubscription();
    };
    const pending = retireSqliteWorkerActor(actor).then(complete, (error: unknown) => {
      current.pending = undefined;
      // Broker settlement has joined all client references and native cleanup.
      // Keep its old operation failure from rejecting a completed custody join.
      if (
        current.entries.size > 0 &&
        [...current.entries].every((entry) => entry.cleanup?.pending === false)
      ) {
        complete();
        return;
      }
      throw error;
    });
    current.pending = pending;
    return retainActorSettlement(current, pending);
  };
  const joinActorRetirement = async (attempt: ActorRetirement): Promise<void> => {
    if (!attempt.pending) {
      throw new Error("Shared-state actor cleanup is pending; close the database before reopening");
    }
    await attempt.pending;
  };
  async function close(identity?: DatabasePathIdentity): Promise<void> {
    for (const entry of stores.values()) {
      if (matches(entry, identity)) {
        void retire(entry);
      }
    }
    const settled = await Promise.allSettled([
      ...[...retiring.keys()].filter((entry) => matches(entry, identity)).map(retire),
      ...[...retiringActors]
        .filter(([, attempt]) => !identity || attempt.identity.key === identity.key)
        .map(([actor, attempt]) => retireActor(actor, attempt.identity)),
    ]);
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    refreshPressureSubscription();
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
  function retireIdleWorkers() {
    for (const entry of stores) {
      if (
        entry.idleTimer &&
        entry.store &&
        !entry.context.maintenanceScope &&
        !hasActiveActorOperations(entry)
      ) {
        void runInDetachedAsyncContext(() => retire(entry)).catch((error: unknown) => {
          log.warn("Idle shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
      }
    }
  }
  return {
    close,
    retainOperation,
    // Source and bundled callers must share the owner's backend URL.
    openCleanup(databasePath: string, context: SqliteWorkerStateContext, assertOwned: () => void) {
      return openSharedStateSqliteWorkerStore<OpenClawStateWorkerCleanupOperations>(
        { ...captureRuntimeWorkerSource(moduleUrl), databasePath, existingOnly: true },
        context,
        assertOwned,
      );
    },
    async open(
      context: OpenClawStateWorkerContext,
      options: Pick<OperationOptions, "existingOnly" | "assertCurrent" | "preparation"> = {},
    ): Promise<Store | undefined> {
      const { existingOnly = false, assertCurrent, preparation } = options;
      const { admission } = context;
      const source = captureRuntimeWorkerSource(moduleUrl);
      const assertAdmission = () => {
        admission.assertCurrent();
        assertCurrent?.();
      };
      assertAdmission();
      isExistingOpenClawStateSchema(admission.databasePath);
      if (getExistingOpenClawStateSchemaPath() !== context.existingSchemaPath) {
        throw new Error("Shared-state worker schema context does not match its caller");
      }
      let entry: Entry | undefined;
      for (;;) {
        for (const candidate of stores) {
          if (
            matches(candidate, admission.identity) &&
            (candidate.context.existingSchemaPath !== context.existingSchemaPath ||
              candidate.source.moduleUrl.href !== source.moduleUrl.href)
          ) {
            await retire(candidate);
            assertAdmission();
          }
        }
        for (const attempt of retiringActors.values()) {
          if (attempt.identity.key === admission.identity.key) {
            await joinActorRetirement(attempt);
            assertAdmission();
          }
        }
        for (const [retiringEntry, attempt] of retiring) {
          if (
            matches(retiringEntry, admission.identity) &&
            retiringEntry.context.maintenanceScope === context.maintenanceScope
          ) {
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
              await attempt.pending;
            } catch (error) {
              if (retiring.get(retiringEntry) === attempt) {
                throw error;
              }
            }
            assertAdmission();
          }
        }
        assertAdmission();
        entry = [...stores].find(
          (candidate) =>
            matches(candidate, admission.identity) &&
            candidate.context.maintenanceScope === context.maintenanceScope &&
            candidate.context.existingSchemaPath === context.existingSchemaPath,
        );
        if (!entry || entry.store || entry.openingAdmission.assertCurrent === assertCurrent) {
          break;
        }
        let rejected: { error: unknown } | undefined;
        try {
          await entry.opening;
        } catch (error) {
          rejected = { error };
        }
        assertAdmission();
        if (
          rejected &&
          (!entry.openingAdmission.refusal ||
            !Object.is(rejected.error, entry.openingAdmission.refusal.error))
        ) {
          throw rejected.error;
        }
      }
      if (!entry) {
        const openingGuard = captureOpenClawStateWorkerOpeningGuard(context, assertCurrent);
        const admitted: Entry = {
          source,
          context,
          openingAdmission: openingGuard.admission,
          existingOnly,
          activeOperations: 0,
          operationGeneration: 0,
          opening: runInDetachedAsyncContext(async () => {
            try {
              return await openSharedStateSqliteWorkerStore<StoreOperations>(
                {
                  ...source,
                  databasePath: admission.databasePath,
                  existingOnly,
                },
                context,
                openingGuard.assertCurrent,
                {
                  maintenanceScope: context.maintenanceScope,
                  preparation,
                  retainCleanup: (cleanup) => {
                    admitted.cleanup = cleanup;
                  },
                },
              );
            } finally {
              openingGuard.releaseContext();
            }
          }),
        };
        entry = admitted;
        admitted.opening = admitted.opening.then((store) => {
          if (store) {
            admitted.store = store;
            admitted.actor = getSqliteWorkerActorIdentity(store);
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
      const store = await entry.opening;
      try {
        admission.assertCurrent();
      } catch (error) {
        try {
          await retire(entry);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Shared-state worker admission and cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
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
      const actorRetirement = entry.actor ? retiringActors.get(entry.actor) : undefined;
      if (entry.actor && actorRetirement) {
        actorRetirement.entries.add(entry);
        stores.delete(entry);
        refreshPressureSubscription();
        await joinActorRetirement(actorRetirement);
        return this.open(context, options);
      }
      if (!isSqliteWorkerStoreAvailable(store) && !hasActiveActorOperations(entry)) {
        await (entry.actor ? retireActor(entry.actor, admission.identity) : retire(entry));
        return this.open(context, options);
      }
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
      stores.delete(entry);
      stores.add(entry);
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

/** Retired cleanup uses the retained owner's backend without renewing read admission. */
export function openOpenClawStateWorkerCleanupStore(
  databasePath: string,
  context: SqliteWorkerStateContext,
  assertOwned: () => void,
) {
  return owner().openCleanup(databasePath, context, assertOwned);
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
  options?: OperationOptions & { existingOnly?: false },
): Promise<T>;
export function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options: OperationOptions & { existingOnly: boolean },
): Promise<T | undefined>;
export async function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: OperationOptions,
): Promise<T | undefined> {
  return runWithCapturedWorkerContext(context, () =>
    runAdmittedOpenClawStateWorkerOperation(context, operation, options),
  );
}

async function runAdmittedOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: OperationOptions,
): Promise<T | undefined> {
  try {
    context.admission.assertCurrent();
    options?.assertCurrent?.();
    const failure = await getOpenClawStateDatabaseTerminalFailureAsync(context);
    if (failure) {
      throw failure;
    }
    context.admission.assertCurrent();
    options?.assertCurrent?.();
    const store = await owner().open(context, options);
    context.admission.assertCurrent();
    if (!store) {
      if (options?.existingOnly) {
        return undefined;
      }
      throw new Error("Canonical shared-state worker did not open its database");
    }
    const releaseOperation = owner().retainOperation(store);
    try {
      context.admission.assertCurrent();
      options?.assertCurrent?.();
      return await runWithOpenClawStateWorkerStore(
        store,
        context,
        operation,
        options?.assertCurrent,
        options?.createAdmission,
      );
    } finally {
      releaseOperation();
    }
  } catch (error) {
    if (error instanceof Error) {
      const hydrated = hydrateOpenClawStateWorkerError(error);
      const failure = findOpenClawStateDatabaseFailure(hydrated, context.admission.databasePath);
      if (
        failure &&
        !openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(
          context.admission.databasePath,
        )
      ) {
        try {
          context.admission.assertCurrent();
        } catch {
          // A retired generation cannot publish a refusal against its replacement.
          throw hydrated;
        }
        recordOpenClawStateDatabaseOpenFailure(context.admission.databasePath, failure);
      }
      throw hydrated;
    }
    throw error;
  }
}

/** Inspect the existing file without recursively admitting a domain operation. */
export async function inspectOpenClawStateDatabase(
  context: OpenClawStateWorkerContext,
  command: {
    type: "database.generationMatches";
    input: OpenClawStateWorkerInspectionOperations["database.generationMatches"]["input"];
  },
): Promise<boolean | undefined> {
  return runWithCapturedWorkerContext(context, () =>
    inspectAdmittedOpenClawStateDatabase(context, command),
  );
}

async function inspectAdmittedOpenClawStateDatabase(
  context: OpenClawStateWorkerContext,
  command: {
    type: "database.generationMatches";
    input: OpenClawStateWorkerInspectionOperations["database.generationMatches"]["input"];
  },
): Promise<boolean | undefined> {
  try {
    const store = await owner().open(context, { existingOnly: true });
    context.admission.assertCurrent();
    if (!store) {
      return undefined;
    }
    const releaseOperation = owner().retainOperation(store);
    try {
      context.admission.assertCurrent();
      return await runWithOpenClawStateWorkerStore(store, context, (scope) =>
        scope.execute(command),
      );
    } finally {
      releaseOperation();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw hydrateOpenClawStateWorkerError(error);
    }
    throw error;
  }
}
