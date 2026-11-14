import { AsyncLocalStorage } from "node:async_hooks";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  getSqliteWorkerActorIdentity,
  runSqliteWorkerStoreOperation,
} from "../infra/sqlite-worker-store.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  getExistingOpenClawStateSchemaPath,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";
import type { Store } from "./openclaw-state-worker-store.types.js";

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
  signal?: AbortSignal,
): Promise<T> {
  const { admission } = context;
  const actor = getSqliteWorkerActorIdentity(store);
  return runSqliteWorkerStoreOperation<OpenClawStateWorkerOperations, T>(
    store,
    (scope) =>
      operation(
        signal
          ? {
              execute: (command, options) =>
                scope.execute(command, {
                  signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
                }),
            }
          : scope,
      ),
    context,
    (commandType) => {
      admission.assertCurrent();
      assertOpenClawStateWorkerActorPath(actor);
      assertCurrent?.(commandType);
    },
    createAdmission,
  );
}

export function assertOpenClawStateWorkerSchemaContext(context: OpenClawStateWorkerContext): void {
  isExistingOpenClawStateSchema(context.admission.databasePath);
  if (getExistingOpenClawStateSchemaPath() !== context.existingSchemaPath) {
    throw new Error("Shared-state worker schema context does not match its caller");
  }
}

/** Native opening retains its physical admission, not an individual command's authority. */
export function captureOpenClawStateWorkerOpeningGuard(context: OpenClawStateWorkerContext) {
  const databaseAdmission = context.admission;
  const identity = databaseAdmission.identity;
  let captured: (() => void) | undefined = AsyncLocalStorage.bind(() =>
    databaseAdmission.assertCurrent(),
  );
  const assertCurrent = () => {
    if (!captured) {
      throw new Error("Shared-state worker opening admission is closed");
    }
    captured();
  };
  return {
    assertCurrent,
    createAdmission: (): ReturnType<SqliteWorkerAdmissionFactory> => {
      let granted = false;
      return {
        nativeLocations: [databaseAdmission.databasePath],
        databaseIdentity: {
          databasePath: databaseAdmission.databasePath,
          key: identity.key,
          birthtime: identity.birthtime,
        },
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (granted || request.stage !== "open") {
            throw new Error("Shared-state worker open admission requested out of order");
          }
          assertCurrent();
          if (!grant()) {
            throw new Error("Shared-state worker open admission expired");
          }
          granted = true;
        }),
      };
    },
    async run<T>(open: () => Promise<T>): Promise<T> {
      try {
        return await open();
      } finally {
        captured = undefined;
      }
    },
  };
}
