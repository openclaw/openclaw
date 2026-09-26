import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-coordinator.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  beginTaskFlowRegistryWorkerMutation,
  ensureTaskFlowRegistryReadyAsync,
} from "./task-flow-runtime-internal.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRegistryWorkerOperations } from "./task-registry.worker-contract.js";

type RestoreOperations = Pick<
  TaskRegistryWorkerOperations,
  "tasks.restore" | "flows.syncMirroredTask"
>;

/** Discovered flow writes enter the registry before admission; their receipts settle after task install. */
export async function runTaskFlowRestoreWorkerOperation<Key extends keyof RestoreOperations, T>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: RestoreOperations[Key]["input"] },
  consume: (result: RestoreOperations[Key]["output"], reconcileFlows: () => Promise<void>) => T,
): Promise<T> {
  const store = getTaskRegistryStore();
  const flowStore = getTaskFlowRegistryStore();
  const publications: Array<() => Promise<void>> = [];
  const errors: unknown[] = [];
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  let reconciliation: Promise<void> | undefined;
  let preparationFailure: { error: unknown } | undefined;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
      throw new Error("Task-flow restore owner is no longer current");
    }
  };
  const reconcileFlows = () =>
    (reconciliation ??= (async () => {
      await settlement;
      if (publications.length === 0) {
        return;
      }
      try {
        assertCurrent();
        await ensureTaskFlowRegistryReadyAsync(context);
        assertCurrent();
      } catch (error) {
        preparationFailure = { error };
        errors.push(error);
      }
      for (const settle of publications) {
        await settle();
      }
      throwSqliteLifecycleErrors(errors, "Task-flow restore reconciliation failed");
    })());
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const value = await runOpenClawStateWorkerOperation(
      context,
      async (scope) => consume(await scope.execute(command), reconcileFlows),
      {
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
                facts.kind !== "task-restored-flow" ||
                typeof facts.taskId !== "string" ||
                !facts.taskId ||
                typeof facts.flowId !== "string" ||
                !facts.flowId ||
                (command.type === "flows.syncMirroredTask" &&
                  (facts.taskId !== command.input?.taskId ||
                    (command.input?.expectedParentFlowId !== undefined &&
                      facts.flowId !== command.input.expectedParentFlowId.trim())))
              ) {
                throw new Error("Task-flow restore admission differs from its operation");
              }
              const flowId = facts.flowId;
              publications.push(
                beginTaskFlowRegistryWorkerMutation(
                  {
                    flowId,
                    admission: context.admission,
                    onPublicationError: (error) => errors.push(error),
                  },
                  () => {
                    if (preparationFailure) {
                      throw preparationFailure.error;
                    }
                    assertCurrent();
                    return flowStore.readFlowAsync(context, flowId);
                  },
                ),
              );
              if (!grant()) {
                throw new Error("Task-flow restore admission expired");
              }
            }),
          };
        },
      },
    );
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await reconcileFlows();
  } catch (error) {
    if (!outcome.ok && outcome.error !== error) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, error],
        "Task-flow restore failed during reconciliation",
        outcome.error,
      );
    }
    throw error;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
