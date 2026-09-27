import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import {
  captureTaskMutationContext,
  finishTaskMutation,
  retainTaskMutationFlowEffects,
} from "./task-executor-mutation-effects.async.js";
import { ensureTaskFlowRegistryReadyAsync } from "./task-flow-runtime-internal.js";
import { readTaskRetentionCommit } from "./task-registry-retention-receipt.js";
import {
  captureTaskRetentionSelection,
  prepareTaskRetention,
  type TaskRetentionResult,
  type TaskRetentionSelection,
} from "./task-registry-retention.operation.js";
import {
  ensureTaskRegistryReadyAsync,
  runTaskRegistryWorkerMutation,
  taskRegistryLog,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export async function applyTaskRegistryMaintenanceRetention(
  selected: TaskRecord,
  now: number,
  cronHistoryOverflowSelections: ReadonlyMap<string, TaskRetentionSelection>,
  assertOwnerCurrent: () => void,
): Promise<"pruned" | "stamped" | undefined> {
  assertOwnerCurrent();
  const { context, store, flowStore, assertStores } = captureTaskMutationContext();
  const selection = {
    taskId: selected.taskId,
    selection:
      cronHistoryOverflowSelections.get(selected.taskId) ?? captureTaskRetentionSelection(selected),
    now,
    cronHistoryOverflow: cronHistoryOverflowSelections.has(selected.taskId),
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    assertStores();
  };
  const scope = { taskId: selected.taskId };
  let committed: TaskRetentionResult | undefined;
  let nativeOwner: SqliteWorkerNativeSettlementOwner | undefined;
  let outcomeKnown = true;
  let flowHookEntered = false;
  try {
    await ensureTaskRegistryReadyAsync(context);
    assertCurrent();
    const source = await store.prepareRetentionSourceAsync(context, selected.taskId);
    assertCurrent();
    if (!source || prepareTaskRetention(source.task, selection).kind === "unchanged") {
      return undefined;
    }
    const input = { ...selection, sourceVersion: source.version };
    if (selected.parentFlowId) {
      await ensureTaskFlowRegistryReadyAsync(context);
      assertCurrent();
    }
    const result = await runTaskRegistryWorkerMutation(
      {
        admission: context.admission,
        scope,
        publicationRecords: () =>
          new Map<string, TaskRecord>(
            committed?.kind === "stamped" ? [[selected.taskId, committed.task]] : [],
          ),
        publicationDeletions: () =>
          new Map<string, TaskRecord>(
            committed?.kind === "pruned" ? [[selected.taskId, committed.previous]] : [],
          ),
        taskRowsWritten: () => committed !== undefined && committed.kind !== "unchanged",
        beforeObservers: async (assertPublicationCurrent) => {
          if (committed?.kind === "stamped") {
            flowHookEntered = true;
            await finishTaskMutation(context, store, flowStore, selected.taskId, {
              operation: "update",
              assertCurrent: () => {
                assertPublicationCurrent();
                assertStores();
              },
            });
          }
        },
      },
      async (beginRecovery) => {
        try {
          const writeResult = await store.runInitialMutationAsync(
            context,
            { type: "tasks.applyRetention", input },
            assertCurrent,
            (owner) => {
              nativeOwner = owner;
              outcomeKnown = false;
              beginRecovery();
            },
          );
          committed =
            writeResult.kind === "unchanged"
              ? writeResult
              : readTaskRetentionCommit(writeResult, input, source);
          if (!committed) {
            throw new Error("Task retention returned no committed outcome");
          }
          outcomeKnown = true;
          return committed;
        } catch (error) {
          committed = readTaskRetentionCommit(nativeOwner?.committed?.facts, input, source);
          if (committed) {
            outcomeKnown = true;
            taskRegistryLog.warn("Task retention committed before result delivery failed", {
              taskId: selected.taskId,
              error,
            });
            return committed;
          }
          throw error;
        }
      },
      () => {
        if (!outcomeKnown) {
          // Keep the existing dirty scope; an absent row cannot prove this operation deleted it.
          throw new Error(
            "Task retention requires canonical reconciliation after an unknown result",
          );
        }
        return store.loadMutationSnapshotAsync(context, scope);
      },
    );
    return result.kind === "unchanged" ? undefined : result.kind;
  } catch (error) {
    assertCurrent();
    taskRegistryLog.warn("Failed to apply task retention", { taskId: selected.taskId, error });
    return undefined;
  } finally {
    if (!flowHookEntered && committed?.kind === "stamped") {
      retainTaskMutationFlowEffects(context, store, flowStore, committed.task, "update");
    }
  }
}
