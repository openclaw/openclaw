import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";

/** Keep the original create owner until every admitted native transaction settles. */
export async function runTaskInitialWorkerOperation<Key extends keyof TaskInitialWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: TaskInitialWorkerOperations[Key]["input"] },
  assertCurrent: () => void,
): Promise<TaskInitialWorkerOperations[Key]["output"]> {
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
      requireStateLifecycle: true,
      assertCurrent,
      createAdmission(retained) {
        settlement = retained.settled;
        assertCurrent();
        return {
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            assertCurrent();
            const facts = request.facts;
            if (
              request.stage !== "transaction" ||
              !isRecord(facts) ||
              facts.kind !== "task-initial-mutation" ||
              facts.operation !== command.type ||
              facts.taskId !== command.input.taskId
            ) {
              throw new Error("Initial task mutation differs from its admitted owner");
            }
            if (!grant()) {
              throw new Error("Initial task mutation admission expired");
            }
          }),
        };
      },
    });
  } finally {
    await settlement;
  }
}
