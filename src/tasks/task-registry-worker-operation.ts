import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerOperationSettlement,
  SqliteWorkerNativeSettlementOwner,
} from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import type { TaskAgentEventWorkerOperations } from "./task-registry-agent-event.operation.js";
import type { TaskRegistryWorkerOperations } from "./task-registry.worker-contract.js";

type Operations = TaskInitialWorkerOperations &
  TaskAgentEventWorkerOperations &
  Pick<TaskRegistryWorkerOperations, "flows.runTask">;

/** Keep the original mutation owner until every admitted native transaction settles. */
export async function runTaskRegistryWorkerOperation<Key extends keyof Operations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: Operations[Key]["input"] },
  assertCurrent: () => void,
  onGranted?: (owner: SqliteWorkerNativeSettlementOwner) => void,
): Promise<Operations[Key]["output"]> {
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
      assertCurrent,
      createAdmission(retained) {
        settlement = retained.settled;
        assertCurrent();
        let retentionStage: "transaction" | "commit" | "completed" = "transaction";
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          assertCurrent();
          const facts = request.facts;
          if (
            (command.type === "tasks.applyRetention"
              ? request.stage !== retentionStage
              : request.stage !== "transaction" &&
                !(
                  request.stage === "commit" &&
                  (command.type === "tasks.bindRunOwner" ||
                    command.type === "tasks.maintainCron" ||
                    command.type === "tasks.finalizeActive" ||
                    command.type === "tasks.settleUnstarted")
                )) ||
            !isRecord(facts) ||
            facts.kind !== "task-registry-mutation" ||
            facts.operation !== command.type ||
            facts.taskId !== command.input.taskId
          ) {
            throw new Error("Task mutation differs from its admitted owner");
          }
          if (!grant()) {
            throw new Error("Task mutation admission expired");
          }
          if (command.type === "tasks.applyRetention") {
            retentionStage = request.stage === "transaction" ? "commit" : "completed";
          }
          if (request.stage === "transaction") {
            onGranted?.(admission);
          }
        });
        return {
          nativeLocations: [context.admission.databasePath],
          admission,
        };
      },
    });
  } finally {
    await settlement;
  }
}
