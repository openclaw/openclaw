import { performance } from "node:perf_hooks";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { SqliteWorkerAdmissionCleanup } from "../infra/sqlite-worker-broker.types.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import {
  openSharedStateSqliteWorkerStore,
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  isSqliteWorkerStoreAvailable,
  getSqliteWorkerActorIdentity,
  retireSqliteWorkerActor,
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
import {
  getExistingOpenClawStateSchemaPath,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import { withOpenClawStateLeaseWorkerAdmission } from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";
import { hydrateOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

type StoreOperations = OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations;
type Store = SqliteWorkerStore<StoreOperations>;
type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;
type OperationOptions = {
  /** Acquire matching lifecycle custody for each dispatched command. */
  requireStateLifecycle?: boolean;
  existingOnly?: boolean;
  assertCurrent?: (commandType?: PropertyKey) => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
const log = createSubsystemLogger("state/worker");
const SHARED_STATE_WORKER_IDLE_INSPECT_MS = 60_000;
const SHARED_STATE_WORKER_IDLE_RETIRE_MS = 30 * 60_000;

function createSharedStateWorkerOwner() {
  type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
  type Entry = {
    context: OpenClawStateWorkerContext;
    opening: Promise<Store | undefined>;
    openingAdmission: { assertCurrent?: () => void; refusal?: { error: unknown } };
    existingOnly: boolean;
    store?: Store;
    actor?: object;
    bound?: boolean;
    cleanup?: SqliteWorkerAdmissionCleanup;
    activeOperations: number;
    operationGeneration: number;
    idleTimer?: IdleTimer;
  };
  const stores = new Set<Entry>();
  const activeEntries = new Set<Entry>();
  const retiring = new Map<Entry, { pending?: Promise<void>; actorSettlement?: Promise<void> }>();
  type ActorRetirement = {
    identity: DatabasePathIdentity;
    entries: Set<Entry>;
    pending?: Promise<void>;
  };
  const retiringActors = new Map<object, ActorRetirement>();
  const matches = (entry: Entry, identity?: DatabasePathIdentity) =>
    identity === undefined || entry.context.admission.identity.key === identity.key;
  const hasActiveActorOperations = (entry: Entry) =>
    [...activeEntries].some((active) =>
      entry.actor ? active.actor === entry.actor : active === entry,
    );
  const forget = (entry: Entry) => {
    stores.delete(entry);
  };
  const clearIdleRetirement = (entry: Entry) => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  };
  const hasPendingCleanup = (entry: Entry) =>
    entry.context.maintenanceScope
      ? entry.cleanup?.pending === true
      : hasUnclaimedSharedStateSqliteCleanup(entry.context.admission.databasePath);
  const retire = (entry: Entry) => {
    clearIdleRetirement(entry);
    forget(entry);
    let attempt = retiring.get(entry);
    if (!attempt) {
      attempt = {};
      retiring.set(entry, attempt);
    }
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
              entry.context.maintenanceScope
                ? entry.cleanup?.close()
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
    const deadline = performance.now() + SHARED_STATE_WORKER_IDLE_RETIRE_MS;
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
                  undefined,
                  true,
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
      const timer: IdleTimer = setTimeout(() => {
        void settle().catch((error: unknown) => {
          log.warn("Idle shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
      }, delay);
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
        forget(entry);
      }
    }
    if (attempt.pending) {
      return retainActorSettlement(attempt, attempt.pending);
    }
    const current = attempt;
    const complete = () => {
      for (const entry of current.entries) {
        clearIdleRetirement(entry);
        forget(entry);
        retiring.delete(entry);
      }
      retiringActors.delete(actor);
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
    retainOperation,
    async open(
      context: OpenClawStateWorkerContext,
      existingOnly = false,
      assertCurrent?: () => void,
    ): Promise<Store | undefined> {
      const { admission } = context;
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
            candidate.context.existingSchemaPath !== context.existingSchemaPath
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
          if (!(await entry.opening)) {
            forget(entry);
          }
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
        const openingAdmission: Entry["openingAdmission"] = { assertCurrent };
        const assertOpeningAdmission = () => {
          admission.assertCurrent();
          try {
            assertCurrent?.();
          } catch (error) {
            openingAdmission.refusal = { error };
            throw error;
          }
        };
        const admitted: Entry = {
          context,
          openingAdmission,
          existingOnly,
          activeOperations: 0,
          operationGeneration: 0,
          opening: openSharedStateSqliteWorkerStore<StoreOperations>(
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
              databasePath: admission.databasePath,
              existingOnly,
            },
            context,
            assertOpeningAdmission,
            {
              maintenanceScope: context.maintenanceScope,
              retainCleanup: (cleanup) => {
                admitted.cleanup = cleanup;
              },
            },
          ),
        };
        entry = admitted;
        admitted.opening = admitted.opening.then((store) => {
          if (store) {
            admitted.store = store;
            admitted.actor = getSqliteWorkerActorIdentity(store);
          }
          return store;
        });
        stores.add(entry);
        context.maintenanceScope?.own(entry, "shared-resources", () => retire(admitted));
        void entry.opening.catch(() => {
          forget(admitted);
          if (hasPendingCleanup(admitted) && !retiring.has(admitted)) {
            retiring.set(admitted, {});
          }
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
        forget(entry);
        return !existingOnly && entry.existingOnly
          ? this.open(context, false, assertCurrent)
          : undefined;
      }
      if (!stores.has(entry)) {
        return this.open(context, existingOnly, assertCurrent);
      }
      entry.store = store;
      clearIdleRetirement(entry);
      const actor = entry.actor;
      const actorRetirement = actor ? retiringActors.get(actor) : undefined;
      if (actor && actorRetirement) {
        actorRetirement.entries.add(entry);
        forget(entry);
        await joinActorRetirement(actorRetirement);
        return this.open(context, existingOnly, assertCurrent);
      }
      if (!isSqliteWorkerStoreAvailable(store) && !hasActiveActorOperations(entry)) {
        await (actor ? retireActor(actor, admission.identity) : retire(entry));
        return this.open(context, existingOnly, assertCurrent);
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
      forget(entry);
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
  options: OperationOptions & { existingOnly: true },
): Promise<T | undefined>;
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

function runWithCapturedWorkerContext<T>(
  context: OpenClawStateWorkerContext,
  operation: () => Promise<T>,
): Promise<T> {
  const maintenance = context.maintenanceScope;
  const run = () =>
    maintenance ? maintenance.run(() => maintenance.track(operation())) : operation();
  return context.runInCapturedSchemaScope ? context.runInCapturedSchemaScope(run) : run();
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
    const store = await owner().open(context, options?.existingOnly, options?.assertCurrent);
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
        // Commands with live admission retain lifecycle custody through native settlement.
        options?.requireStateLifecycle === true || options?.createAdmission !== undefined,
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
    const store = await owner().open(context, true);
    context.admission.assertCurrent();
    if (!store) {
      return undefined;
    }
    const releaseOperation = owner().retainOperation(store);
    try {
      context.admission.assertCurrent();
      return await runWithOpenClawStateWorkerStore(store, context, (scope) =>
        scope.execute({
          type: "database.generationMatches",
          input: command.input,
        }),
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

function runWithOpenClawStateWorkerStore<T>(
  store: Store,
  context: OpenClawStateWorkerContext,
  operation: (scope: Pick<Store, "execute">) => Promise<T>,
  assertCurrent?: (commandType?: PropertyKey) => void,
  createAdmission?: SqliteWorkerAdmissionFactory,
  requireStateLifecycle = false,
): Promise<T> {
  const { admission } = context;
  return runSqliteWorkerStoreOperation<StoreOperations, T>(
    store,
    operation,
    context,
    (commandType) => {
      admission.assertCurrent();
      assertCurrent?.(commandType);
    },
    createAdmission,
    requireStateLifecycle,
  );
}

/** Retain the actual lease until every admitted worker transaction has settled. */
export function runWithOpenClawStateLeaseWorker<T>(
  lease: OpenClawStateLeaseContext,
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope, identity: OpenClawStateLeaseIdentity) => Promise<T>,
): Promise<T> {
  return withOpenClawStateLeaseWorkerAdmission(lease, context.admission.databasePath, (admission) =>
    runOpenClawStateWorkerOperation(context, (scope) => operation(scope, admission.identity), {
      assertCurrent: admission.assertCurrent,
      createAdmission: admission.createAdmission,
    }),
  );
}
