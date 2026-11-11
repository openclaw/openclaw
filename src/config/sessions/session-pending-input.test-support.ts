import { vi } from "vitest";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { stageSessionPendingInput } from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";

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

export function createPendingHistoryFixture(name: string, sessionId = name) {
  const scope = { agentId: "main", sessionKey: `agent:main:${name}`, sessionId };
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
  writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
  return { scope, database };
}

export function createUserPendingInput(
  runId: string,
  content: string,
  idempotencyKey: string,
): Parameters<typeof stageSessionPendingInput>[1] {
  return {
    runId,
    message: { role: "user", content, timestamp: 1, idempotencyKey },
    assertCurrent() {},
  };
}
