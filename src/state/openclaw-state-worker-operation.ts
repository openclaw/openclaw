import { AsyncLocalStorage } from "node:async_hooks";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import {
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

type StoreOperations = OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations;
type Store = SqliteWorkerStore<StoreOperations>;

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

/** Only native opening owns the caller scope; a cached actor must not retain it. */
export function captureOpenClawStateWorkerOpeningGuard(
  context: OpenClawStateWorkerContext,
  assertCurrent?: () => void,
) {
  const admission: { assertCurrent?: () => void; refusal?: { error: unknown } } = {
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
