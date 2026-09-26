import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";

type SessionMaintenancePlanningWorkerResponse = {
  kind: "committed" | "not-committed";
  workerThreadId: number;
};

export function observeSessionMaintenancePlanningWorker(hooks: {
  beforeExecute?: () => void;
  beforeAdmission?: (request: admission.SqliteWorkerAdmissionRequest) => void;
  afterExecute?: (
    result: SessionMaintenancePlanningWorkerResponse,
    native: {
      admission?: admission.SqliteWorkerOperationAdmission;
      retained?: RetainedWorkerTransactionAdmission;
    },
  ) => void | Promise<void>;
}) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
        requireStateLifecycle?: Parameters<typeof original>[5],
      ) => {
        let planning = false;
        let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
        let nativeRetention: RetainedWorkerTransactionAdmission | undefined;
        return original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                planning =
                  command.type === "session.maintenance.metadata" &&
                  isRecord(command.input) &&
                  command.input.kind === "maintenance-plan";
                if (planning) {
                  hooks.beforeExecute?.();
                }
                const result = await worker.execute(command, options);
                if (planning) {
                  if (!isRecord(result) || typeof result.workerThreadId !== "number") {
                    throw new Error("Real maintenance omitted its native worker identity");
                  }
                  if (result.kind !== "committed" && result.kind !== "not-committed") {
                    throw new Error("Real maintenance omitted its native outcome");
                  }
                  await hooks.afterExecute?.(
                    { kind: result.kind, workerThreadId: result.workerThreadId },
                    { admission: nativeAdmission, retained: nativeRetention },
                  );
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission &&
            ((retained) => {
              if (!planning) {
                return createAdmission(retained);
              }
              const authorize = admission.createSqliteWorkerOperationAdmission;
              const observer = hooks.beforeAdmission
                ? vi
                    .spyOn(admission, "createSqliteWorkerOperationAdmission")
                    .mockImplementation((callback, attachment) =>
                      authorize((request, grant) => {
                        hooks.beforeAdmission?.(request);
                        return callback(request, grant);
                      }, attachment),
                    )
                : undefined;
              try {
                const owned = createAdmission(retained);
                nativeRetention = retained;
                nativeAdmission = owned.admission;
                return owned;
              } finally {
                observer?.mockRestore();
              }
            }),
          requireStateLifecycle,
        );
      },
    );
}

/** Row changes precede archive publication; join the owner's complete finalization. */
export function observeSessionMaintenanceCompletion(databasePath: string) {
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
  const observer = vi
    .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
    .mockImplementation((scope, ...args) => {
      const result = finalize(scope, ...args);
      if (scope.path === databasePath) {
        completed.resolve(result);
      }
      return result;
    });
  onTestFinished(() => observer.mockRestore());
  return completed.promise;
}

/** Observe committed maintenance rows without imposing a worker-startup deadline. */
export function observeSessionMaintenanceChanges(databasePath: string, ...sessionKeys: string[]) {
  const pending = new Set(sessionKeys);
  const completed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (!("sessionKey" in change) || change.storePath !== databasePath) {
      return;
    }
    if (pending.delete(change.sessionKey) && pending.size === 0) {
      unsubscribe();
      completed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  return completed.promise;
}
