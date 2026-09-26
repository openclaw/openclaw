import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  hasAuthoritativeTaskBackingFromRecords,
  readManagedTaskBacking,
  sameTaskBackingInstance,
  selectCurrentCanonicalTaskBacking,
} from "../tasks/task-backing-records.js";
import { matchesTaskCancellationSelection } from "../tasks/task-cancellation-selection.js";
import { prepareCronTaskMaintenance } from "../tasks/task-cron-maintenance-policy.js";
import { restoreTaskExecutionSnapshot } from "../tasks/task-execution-owner.js";
import {
  applyFlowPatch,
  isTaskMirroredFlowSyncUnchanged,
  normalizeRestoredFlowRecord,
  prepareTaskMirroredFlowSyncFromCurrent,
} from "../tasks/task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type {
  TaskFlowRegistryMirroredSync,
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
} from "../tasks/task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  runTaskFlowRegistryWorkerMutation,
} from "../tasks/task-flow-runtime-internal.js";
import { buildManagedFlowCancellationPatch } from "../tasks/task-initial-flow.rules.js";
import type { TaskInitialWorkerOperations } from "../tasks/task-initial-worker.types.js";
import {
  acknowledgeTaskStateNotification,
  updateTaskNotificationDelivery,
} from "../tasks/task-notification.operation.js";
import { captureTaskCreationEventTarget } from "../tasks/task-registry-agent-event-target.js";
import {
  captureTaskAgentEventLineage,
  prepareTaskAgentEventUpdate,
} from "../tasks/task-registry-agent-event.operation.js";
import { selectExistingTaskForCreate } from "../tasks/task-registry-create-rules.js";
import { runTaskCreateOperation } from "../tasks/task-registry-create.operation.js";
import { assertParentFlowRecordLinkAllowed } from "../tasks/task-registry-parent-flow-rules.js";
import {
  findLatestTaskForFlowInSnapshot,
  normalizeTaskTimestamps,
} from "../tasks/task-registry-records.js";
import type {
  TaskMirroredFlowSyncOutcome,
  TaskRegistryRestoreResult,
} from "../tasks/task-registry-restore.worker.js";
import { captureTaskRetentionCommit } from "../tasks/task-registry-retention-receipt.js";
import { captureTaskRetentionSource } from "../tasks/task-registry-retention-source.js";
import { prepareTaskRetention } from "../tasks/task-registry-retention.operation.js";
import type { TaskWorkerTransitionInput } from "../tasks/task-registry-transition.kernel.js";
import {
  runTaskRecordTransitionOperation,
  type TaskRecordTransitionInput,
} from "../tasks/task-registry-transition.operation.js";
import type { TaskRegistryStore, TaskRegistryStoreSnapshot } from "../tasks/task-registry.store.js";
import type { TaskRegistryMutationScope } from "../tasks/task-registry.store.types.js";

type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;

/** Synthetic stores supply the same host reconciliation continuation as native restore receipts. */
export async function reconcileTaskFlowRestoreForTests(
  context: OpenClawStateWorkerContext,
  flowIds: readonly string[],
): Promise<void> {
  if (flowIds.length === 0) {
    return;
  }
  const store = getTaskFlowRegistryStore();
  await ensureTaskFlowRegistryReadyAsync(context);
  for (const flowId of new Set(flowIds)) {
    await runTaskFlowRegistryWorkerMutation(
      { flowId, admission: context.admission },
      () => Promise.resolve(),
      () => store.readFlowAsync(context, flowId),
    );
  }
}

function syncRestoredTaskFlow(
  taskStore: TaskRegistryStore,
  flowStore: TaskFlowRegistryStore,
  params: { taskId: string; expectedParentFlowId?: string },
): TaskMirroredFlowSyncOutcome {
  const { taskId } = params;
  let flowId = params.expectedParentFlowId?.trim();
  try {
    const snapshot = taskStore.loadSnapshot();
    const task = snapshot.tasks.get(taskId);
    const currentParentFlowId = task?.parentFlowId?.trim();
    if (
      !task ||
      !currentParentFlowId ||
      (params.expectedParentFlowId !== undefined && currentParentFlowId !== flowId)
    ) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    flowId = currentParentFlowId;
    if (findLatestTaskForFlowInSnapshot(snapshot.tasks, flowId)?.taskId !== taskId) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    const stored = flowStore.loadSnapshot().flows.get(flowId);
    if (!stored) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    const current = normalizeRestoredFlowRecord(stored);
    if (current.syncMode !== "task_mirrored") {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: current } };
    }
    const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, current);
    if (isTaskMirroredFlowSyncUnchanged(prepared)) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: current } };
    }
    try {
      flowStore.upsertFlow(prepared.next);
      return { taskId, flowId, kind: "result", result: { ok: true, flow: prepared.next } };
    } catch {
      return {
        taskId,
        flowId,
        kind: "result",
        result: { ok: false, reason: "persist_failed", current },
      };
    }
  } catch (error) {
    return {
      taskId,
      flowId,
      kind: "error",
      error: serializeAgentSchemaInspectionError(error),
    };
  }
}

export function createInMemoryTaskRegistryStore(
  snapshot: TaskRegistryStoreSnapshot = { tasks: new Map(), deliveryStates: new Map() },
  flowStore?: TaskFlowRegistryStore,
): TaskRegistryStore {
  const state = structuredClone(snapshot);
  return {
    async prepareRetentionSourceAsync(context, taskId) {
      context.admission.assertCurrent();
      const task = this.loadSnapshot().tasks.get(taskId);
      return task ? captureTaskRetentionSource(normalizeTaskTimestamps(task)) : undefined;
    },
    settleAgentEventWrites(join) {
      join(performance.now() + 5_000);
    },
    async runAgentEventMutationAsync(_context, input, assertCurrent, onGranted) {
      const current = this.loadSnapshot().tasks.get(input.taskId);
      const receipt = current ? prepareTaskAgentEventUpdate(current, input) : null;
      if (!receipt) {
        return null;
      }
      assertCurrent();
      this.upsertTaskWithDeliveryState({
        task: receipt.task,
        deliveryState: this.loadSnapshot().deliveryStates.get(input.taskId),
      });
      const settlement = {
        kind: "completed" as const,
        committed: { facts: captureTaskAgentEventLineage(receipt) },
      };
      onGranted({
        committed: settlement.committed,
        settlement,
        waitForSettlement: () => settlement,
      });
      return receipt;
    },
    async runInitialMutationAsync(context, command, assertCurrent, onGranted) {
      const unsupported = (): never => {
        throw new Error("Initial flow mutations require the isolated worker fixture.");
      };
      const transitionRecord = (
        transition: TaskRecordTransitionInput & Pick<TaskWorkerTransitionInput, "selectedTask">,
      ) =>
        runTaskRecordTransitionOperation(transition, {
          readCurrent: () => {
            const task = this.loadSnapshot().tasks.get(transition.taskId);
            const selected = transition.selectedTask;
            if (task && selected && task.taskId !== selected.taskId) {
              const managed = readManagedTaskBacking(task.detail);
              if (
                !selected.backing ||
                !managed ||
                managed.taskId !== selected.taskId ||
                !sameTaskBackingInstance(managed.instance, selected.backing) ||
                !task.parentFlowId ||
                flowStore?.loadSnapshot().flows.get(task.parentFlowId)?.syncMode !== "managed"
              ) {
                return undefined;
              }
            }
            return task;
          },
          hasAuthoritativeBacking: (task) =>
            hasAuthoritativeTaskBackingFromRecords(task, {
              isManagedFlow: (flowId) =>
                flowStore?.loadSnapshot().flows.get(flowId)?.syncMode === "managed",
              resolveCurrentCanonicalBacking: (scope) =>
                selectCurrentCanonicalTaskBacking({
                  ...scope,
                  candidates: [...this.loadSnapshot().tasks.values()],
                  isTaskMirroredFlow: (flowId) =>
                    flowStore?.loadSnapshot().flows.get(flowId)?.syncMode === "task_mirrored",
                }),
            }),
          write: (operation) => operation(),
          upsertTask: (task) => {
            this.upsertTaskWithDeliveryState({
              task,
              deliveryState: this.loadSnapshot().deliveryStates.get(task.taskId),
            });
            return true;
          },
          assertCurrent,
          deferCommit: (publish) => publish(),
          onCommitted() {},
        });
      const operations: {
        [Key in keyof TaskInitialWorkerOperations]: (
          input: TaskInitialWorkerOperations[Key]["input"],
        ) => TaskInitialWorkerOperations[Key]["output"];
      } = {
        "tasks.maintainCron": (input) => {
          const result = prepareCronTaskMaintenance(
            state.tasks.get(input.taskId),
            [...state.tasks.values()]
              .filter(
                (task) =>
                  task.runtime === "cron" && task.sourceId === input.selected.sourceId?.trim(),
              )
              .toSorted(
                (a, b) =>
                  a.createdAt - b.createdAt ||
                  Buffer.compare(Buffer.from(a.taskId), Buffer.from(b.taskId)),
              ),
            input,
          );
          assertCurrent();
          if (result?.persisted) {
            this.upsertTaskWithDeliveryState({
              task: result.task,
              deliveryState: state.deliveryStates.get(input.taskId),
            });
          }
          return result;
        },
        "tasks.applyRetention": (input) => {
          const stored = state.tasks.get(input.taskId);
          const current = stored && normalizeTaskTimestamps(stored);
          if (!current || captureTaskRetentionSource(current).version !== input.sourceVersion) {
            return { kind: "unchanged" };
          }
          const result = prepareTaskRetention(current, input);
          assertCurrent();
          if (result.kind === "pruned") {
            state.tasks.delete(input.taskId);
            state.deliveryStates.delete(input.taskId);
          } else if (result.kind === "stamped") {
            this.upsertTaskWithDeliveryState({
              task: result.task,
              deliveryState: state.deliveryStates.get(input.taskId),
            });
          }
          return result.kind === "unchanged" ? result : captureTaskRetentionCommit(input, result);
        },
        "tasks.cancelRow": (input) => {
          const current = this.loadSnapshot().tasks.get(input.taskId);
          return current && matchesTaskCancellationSelection(current, input.selectedTask)
            ? transitionRecord({
                kind: "state",
                taskId: input.taskId,
                params: input.params,
                now: input.now,
              })
            : null;
        },
        "tasks.transitionRunRow": (input) => transitionRecord(input),
        "tasks.bindRunOwner": (input) => transitionRecord({ kind: "run-owner", ...input }),
        "tasks.acknowledgeStateChange": (input) =>
          acknowledgeTaskStateNotification(input, {
            readCurrent: () => ({
              task: state.tasks.get(input.taskId),
              deliveryState: state.deliveryStates.get(input.taskId),
            }),
            write: (write) => write(),
            assertCurrent,
            upsertDelivery: (deliveryState) => this.upsertDeliveryState(deliveryState),
            upsertTask: (task, deliveryState) =>
              this.upsertTaskWithDeliveryState({ task, deliveryState }),
            deferCommit: (publish) => publish(),
            onCommitted() {},
            onFailure() {},
          }),
        "tasks.updateNotificationDelivery": (input) =>
          updateTaskNotificationDelivery(input, {
            readCurrent: () => ({
              task: state.tasks.get(input.taskId),
              deliveryState: state.deliveryStates.get(input.taskId),
            }),
            write: (write) => write(),
            assertCurrent,
            upsertDelivery: (deliveryState) => this.upsertDeliveryState(deliveryState),
            upsertTask: (task, deliveryState) =>
              this.upsertTaskWithDeliveryState({ task, deliveryState }),
            deferCommit: (publish) => publish(),
            onCommitted() {},
            onFailure() {},
          }),
        "tasks.createRecord": (input) =>
          runTaskCreateOperation(input, {
            readSelection: (identity) => {
              const flows = flowStore?.loadSnapshot().flows;
              const parentFlowId = input.params.parentFlowId?.trim();
              assertParentFlowRecordLinkAllowed(
                { ...identity, parentFlowId },
                parentFlowId ? flows?.get(parentFlowId) : undefined,
              );
              const current = this.loadSnapshot();
              const existing = selectExistingTaskForCreate({
                ...input.params,
                ...identity,
                candidates: [...current.tasks.values()].toSorted(
                  (left, right) =>
                    left.createdAt - right.createdAt ||
                    (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
                ),
                isTaskMirroredFlow: (flowId) => flows?.get(flowId)?.syncMode === "task_mirrored",
              });
              return {
                existing,
                deliveryState: existing ? current.deliveryStates.get(existing.taskId) : undefined,
              };
            },
            write: (operation) => operation(),
            assertCurrent,
            upsertDelivery: (deliveryState) => this.upsertDeliveryState(deliveryState),
            upsertTask: (task, deliveryState) =>
              this.upsertTaskWithDeliveryState({ task, deliveryState }),
            deferCommit: (publish) => publish(),
            onCommitted: (commit) => {
              const taskId =
                commit.kind === "task" ? commit.result.task.taskId : commit.task.taskId;
              const task = this.loadSnapshot().tasks.get(taskId);
              if (task?.runId) {
                const settlement = {
                  kind: "completed" as const,
                  committed: {
                    facts: captureTaskCreationEventTarget(task, "tasks.createRecord", input.taskId),
                  },
                };
                onGranted?.({
                  committed: settlement.committed,
                  settlement,
                  waitForSettlement: () => settlement,
                });
              }
            },
          }),
        "tasks.finalizeActive": (input) => transitionRecord({ kind: "state", ...input }),
        "flows.createForTask": unsupported,
        "tasks.settleUnstarted": (input) => {
          const current = this.loadSnapshot().tasks.get(input.taskId);
          if (
            !current ||
            (current.status !== "queued" && current.status !== "running") ||
            current.endedAt !== undefined
          ) {
            return null;
          }
          const params = {
            ...input.terminal,
            runId: input.expectedTask.runId,
            runtime: input.expectedTask.runtime,
            sessionKey: input.expectedTask.childSessionKey ?? input.expectedTask.ownerKey,
          };
          return transitionRecord({
            kind: "state",
            taskId: input.taskId,
            now: input.now,
            expectedTask: input.expectedTask,
            params,
          });
        },
        "tasks.linkInitialFlow": unsupported,
        "flows.deleteUnlinkedForTask": unsupported,
        "flows.finalizeTaskCancellation": (input) => {
          const task = state.tasks.get(input.taskId) ?? null;
          if (!task || task.parentFlowId?.trim() !== input.flowId || !flowStore) {
            return { changed: false, task, flow: null };
          }
          const stored = flowStore.loadSnapshot().flows.get(input.flowId);
          if (!stored) {
            return { changed: false, task, flow: null };
          }
          const flow = normalizeRestoredFlowRecord(stored);
          const patch = buildManagedFlowCancellationPatch(
            task,
            flow,
            () => [...state.tasks.values()].filter((row) => row.parentFlowId === flow.flowId),
            input.now,
          );
          if (!patch) {
            return { changed: false, task, flow };
          }
          const next = applyFlowPatch(flow, patch);
          assertCurrent();
          flowStore.upsertFlow(next);
          return { changed: true, task, flow: next, previous: flow };
        },
      };
      context.admission.assertCurrent();
      assertCurrent();
      return operations[command.type](command.input);
    },
    async syncLiveTaskFlowAsync(_context, params, authority) {
      if (!flowStore) {
        throw new Error(
          "In-memory live task-flow synchronization requires an explicit flow store.",
        );
      }
      authority.assertCurrent();
      const task = structuredClone(state.tasks.get(params.taskId));
      if (
        !task ||
        task.parentFlowId?.trim() !== params.flowId ||
        !authority.isSelected({ ...params, createdAt: task.createdAt })
      ) {
        return { kind: "not-selected" };
      }
      authority.assertCurrent();
      const current = flowStore.loadSnapshot().flows.get(params.flowId);
      try {
        const result = flowStore.syncMirroredTask(task, () => ({
          stage() {},
          rollback() {},
          commit() {},
          publish() {},
        }));
        return { kind: "result", result: { ok: true, flow: result.flow } };
      } catch (error) {
        if (!current) {
          throw error;
        }
        return { kind: "result", result: { ok: false, reason: "persist_failed", current } };
      }
    },
    async withSnapshotAsync<T>(
      this: TaskRegistryStore,
      context: OpenClawStateWorkerContext,
      consume: (result: TaskRegistryRestoreResult, reconcileFlows: () => Promise<void>) => T,
    ): Promise<T> {
      const restored = restoreTaskExecutionSnapshot(this);
      const flowSyncs = restored.settledTasks.flatMap((task) => {
        const flowId = task.parentFlowId?.trim();
        if (!flowId) {
          return [];
        }
        if (!flowStore) {
          throw new Error(
            "In-memory task restoration with linked settlements requires an explicit flow store.",
          );
        }
        return [
          syncRestoredTaskFlow(this, flowStore, {
            taskId: task.taskId,
            expectedParentFlowId: flowId,
          }),
        ];
      });
      return consume({ ...restored, flowSyncs }, () =>
        reconcileTaskFlowRestoreForTests(
          context,
          flowSyncs.flatMap((outcome) => (outcome.flowId ? [outcome.flowId] : [])),
        ),
      );
    },
    async syncTaskFlowAsync(
      this: TaskRegistryStore,
      context: OpenClawStateWorkerContext,
      params: { taskId: string; expectedParentFlowId?: string },
    ): Promise<TaskMirroredFlowSyncOutcome> {
      if (!flowStore) {
        throw new Error("In-memory task flow synchronization requires an explicit flow store.");
      }
      const outcome = syncRestoredTaskFlow(this, flowStore, params);
      await reconcileTaskFlowRestoreForTests(context, outcome.flowId ? [outcome.flowId] : []);
      return outcome;
    },
    loadSnapshot: () => structuredClone(state),
    async loadMutationSnapshotAsync(
      this: TaskRegistryStore,
      _context: OpenClawStateWorkerContext,
      scope?: TaskRegistryMutationScope | readonly TaskRegistryMutationScope[],
    ): Promise<TaskRegistryStoreSnapshot> {
      const projectionSnapshot = structuredClone(this.loadSnapshot());
      if (!scope) {
        return projectionSnapshot;
      }
      const scopes = "taskId" in scope ? [scope] : scope;
      const tasks = new Map(
        [...projectionSnapshot.tasks].filter(([taskId, task]) =>
          scopes.some(
            (entry) =>
              taskId === entry.taskId ||
              Boolean(entry.runId?.trim() && task.runId?.trim() === entry.runId.trim()) ||
              Boolean(
                entry.childSessionKey?.trim() &&
                task.childSessionKey?.trim() === entry.childSessionKey.trim(),
              ),
          ),
        ),
      );
      return {
        tasks,
        deliveryStates: new Map(
          [...projectionSnapshot.deliveryStates].filter(([taskId]) => tasks.has(taskId)),
        ),
      };
    },
    upsertTaskWithDeliveryState: ({ task, deliveryState }) => {
      const nextTask = structuredClone(task);
      const nextDeliveryState = deliveryState ? structuredClone(deliveryState) : undefined;
      state.tasks.set(task.taskId, nextTask);
      if (nextDeliveryState) {
        state.deliveryStates.set(task.taskId, nextDeliveryState);
      } else {
        state.deliveryStates.delete(task.taskId);
      }
    },
    upsertDeliveryState: (deliveryState) => {
      state.deliveryStates.set(deliveryState.taskId, structuredClone(deliveryState));
    },
  };
}

export function createInMemoryTaskFlowRegistryStore(
  snapshot: TaskFlowRegistryStoreSnapshot = { flows: new Map() },
): TaskFlowRegistryStore {
  const state = structuredClone(snapshot);
  return {
    withSnapshotAsync: async (_context, consume) => consume(structuredClone(state)),
    readFlowAsync: async (_context, flowId) => structuredClone(state.flows.get(flowId)),
    loadSnapshot: (flowIds) => {
      const flows = new Map<string, TaskFlowRecord>();
      for (const flowId of flowIds ?? state.flows.keys()) {
        const flow = state.flows.get(flowId);
        if (flow) {
          flows.set(flowId, structuredClone(flow));
        }
      }
      return { flows };
    },
    upsertFlow: (flow) => {
      state.flows.set(flow.flowId, structuredClone(flow));
    },
    syncMirroredTask(task, preparePublication) {
      const stored = state.flows.get(task.parentFlowId?.trim() ?? "");
      let result: TaskFlowRegistryMirroredSync = { changed: false, flow: null };
      if (stored) {
        const current = normalizeRestoredFlowRecord(stored);
        result = { changed: false, flow: current };
        if (current.syncMode === "task_mirrored") {
          const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, current);
          if (!isTaskMirroredFlowSyncUnchanged(prepared)) {
            this.upsertFlow(prepared.next);
            result = { changed: true, flow: prepared.next, previous: current };
          }
        }
      }
      const publication = preparePublication(result);
      publication.stage();
      publication.commit();
      return result;
    },
    updateFlow: (params, preparePublication) => {
      const publish = (result: TaskFlowRegistryObservedUpdate) => {
        const publication = preparePublication(result);
        publication.stage();
        publication.commit();
        return result;
      };
      const stored = state.flows.get(params.flowId);
      if (!stored) {
        return publish({ applied: false, reason: "not_found" });
      }
      const current = normalizeRestoredFlowRecord(stored);
      if (current.revision !== params.expectedRevision) {
        return publish({
          applied: false,
          reason: "revision_conflict",
          current: structuredClone(current),
        });
      }
      let flow;
      try {
        flow = applyFlowPatch(current, params.patch);
      } catch (error) {
        return { applied: false, reason: "invalid_patch", error };
      }
      state.flows.set(flow.flowId, structuredClone(flow));
      return publish({ applied: true, previous: structuredClone(current), flow });
    },
    deleteFlow: (flowId) => {
      state.flows.delete(flowId);
    },
  };
}
