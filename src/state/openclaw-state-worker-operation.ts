import { AsyncLocalStorage } from "node:async_hooks";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import {
  getSqliteWorkerActorIdentity,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpeningAdmission,
  Store,
  StoreOperations,
} from "./openclaw-state-worker-store.types.js";

/** A live alias cannot authorize a worker still bound to a vanished opening path. */
export function assertOpenClawStateWorkerActorPath(
  actor: ReturnType<typeof getSqliteWorkerActorIdentity>,
): void {
  const identity = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
    actor.databasePath,
  );
  if (identity?.key !== actor.key) {
    throw new StateDatabaseReadAdmissionInvalidatedError(
      "Shared-state worker opening path changed",
    );
  }
}

export function runWithCapturedWorkerContext<T>(
  context: OpenClawStateWorkerContext,
  operation: () => Promise<T>,
): Promise<T> {
  const maintenance = context.maintenanceScope;
  const run = () =>
    maintenance ? maintenance.run(() => maintenance.track(operation())) : operation();
  return context.runInCapturedSchemaScope ? context.runInCapturedSchemaScope(run) : run();
}

export function runWithOpenClawStateWorkerStore<T>(
  store: Store,
  context: OpenClawStateWorkerContext,
  operation: (scope: Pick<Store, "execute">) => Promise<T>,
  assertCurrent?: (commandType?: PropertyKey) => void,
  createAdmission?: SqliteWorkerAdmissionFactory,
): Promise<T> {
  const { admission } = context;
  const actor = getSqliteWorkerActorIdentity(store);
  return runSqliteWorkerStoreOperation<StoreOperations, T>(
    store,
    operation,
    context,
    (commandType) => {
      admission.assertCurrent();
      assertOpenClawStateWorkerActorPath(actor);
      assertCurrent?.(commandType);
    },
    createAdmission,
  );
}

/** Only native opening owns the caller scope; a cached actor must not retain it. */
export function captureOpenClawStateWorkerOpeningGuard(
  context: OpenClawStateWorkerContext,
  assertCurrent?: () => void,
) {
  const admission: OpeningAdmission = {
    assertCurrent,
  };
  let captured: (() => void) | undefined = AsyncLocalStorage.bind(() => {
    context.admission.assertCurrent();
    try {
      assertCurrent?.();
    } catch (error) {
      admission.refusal = { error };
      throw error;
    }
  });
  return {
    admission,
    assertCurrent: () => {
      if (!captured) {
        throw new Error("Shared-state worker opening admission is closed");
      }
      captured();
    },
    releaseContext() {
      captured = undefined;
    },
  };
}
