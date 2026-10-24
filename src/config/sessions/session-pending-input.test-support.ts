import { vi } from "vitest";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";

type Worker<Operations extends SqliteWorkerOperations> = Pick<
  SqliteWorkerStore<Operations>,
  "execute"
>;

export function interceptPendingInputWorker(
  decorate: <Operations extends SqliteWorkerOperations>(
    worker: Worker<Operations>,
    context: { onAdmission?: (admission: SqliteWorkerOperationAdmission) => void },
  ) => Worker<Operations>,
) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation((store, operation, stateContext, assertCurrent, createAdmission) => {
      const context: Parameters<typeof decorate>[1] = {};
      return original(
        store,
        (worker) => operation(decorate(worker, context)),
        stateContext,
        assertCurrent,
        createAdmission &&
          ((retained) => {
            const owned = createAdmission(retained);
            context.onAdmission?.(owned.admission);
            return owned;
          }),
      );
    });
}
