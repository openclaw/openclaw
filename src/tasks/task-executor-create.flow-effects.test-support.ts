import { vi } from "vitest";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { applyFlowPatch } from "./task-flow-registry.records.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { buildManagedFlowCancellationPatch } from "./task-initial-flow.rules.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import { ensureTaskRegistryReadyAsync } from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { configureTaskFlowRegistryRuntime } from "./task-runtime.test-helpers.js";

export const ownerKey = "agent:main:committed-flow";
export const flow: TaskFlowRecord = {
  flowId: "committed-flow",
  syncMode: "task_mirrored",
  ownerKey,
  goal: "Synthetic flow",
  status: "queued",
  notifyPolicy: "silent",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
export async function createTaskFlowEffectsFixture(
  syncMode: TaskFlowRecord["syncMode"] = "task_mirrored",
  flowIds: readonly string[] = [flow.flowId],
) {
  const initial = {
    ...flow,
    syncMode,
    ...(syncMode === "managed" ? { controllerId: "proof" } : {}),
  };
  const flows = createInMemoryTaskFlowRegistryStore({
    flows: new Map(flowIds.map((flowId) => [flowId, { ...initial, flowId }])),
  });
  const store = createInMemoryTaskRegistryStore(undefined, flows);
  const originalCreate = store.runInitialMutationAsync.bind(store);
  const commands: Array<keyof TaskInitialWorkerOperations> = [];
  const beforeFinalize =
    vi.fn<
      (input: TaskInitialWorkerOperations["flows.finalizeTaskCancellation"]["input"]) => void
    >();
  store.runInitialMutationAsync = async function (context, command, assertCurrent, onGranted) {
    commands.push(command.type);
    context.admission.assertCurrent();
    assertCurrent();
    const unsupported = (): never => {
      throw new Error("Unexpected initial flow command");
    };
    const operations: {
      [Key in keyof TaskInitialWorkerOperations]: (
        input: TaskInitialWorkerOperations[Key]["input"],
      ) =>
        | TaskInitialWorkerOperations[Key]["output"]
        | Promise<TaskInitialWorkerOperations[Key]["output"]>;
    } = {
      "tasks.bindRunOwner": (input) =>
        originalCreate(context, { type: "tasks.bindRunOwner", input }, assertCurrent, onGranted),
      "tasks.acknowledgeStateChange": (input) =>
        originalCreate(
          context,
          { type: "tasks.acknowledgeStateChange", input },
          assertCurrent,
          onGranted,
        ),
      "tasks.updateNotificationDelivery": (input) =>
        originalCreate(
          context,
          { type: "tasks.updateNotificationDelivery", input },
          assertCurrent,
          onGranted,
        ),
      "tasks.createRecord": (input) =>
        originalCreate(context, { type: "tasks.createRecord", input }, assertCurrent, onGranted),
      "tasks.settleUnstarted": (input) =>
        originalCreate(context, { type: "tasks.settleUnstarted", input }, assertCurrent, onGranted),
      "tasks.setCronDeliveryEvidence": (input) =>
        originalCreate(
          context,
          { type: "tasks.setCronDeliveryEvidence", input },
          assertCurrent,
          onGranted,
        ),
      "tasks.setDeliveryStatus": (input) =>
        originalCreate(
          context,
          { type: "tasks.setDeliveryStatus", input },
          assertCurrent,
          onGranted,
        ),
      "flows.finalizeTaskCancellation": (input) => {
        beforeFinalize(input);
        const task = store.loadSnapshot().tasks.get(input.taskId) ?? null;
        if (!task || task.parentFlowId?.trim() !== input.flowId) {
          return { changed: false, task, flow: null };
        }
        const current = flows.loadSnapshot().flows.get(input.flowId) ?? null;
        const patch =
          task &&
          current &&
          buildManagedFlowCancellationPatch(
            task,
            current,
            () =>
              [...store.loadSnapshot().tasks.values()].filter(
                (item) => item.parentFlowId === current.flowId,
              ),
            input.now,
          );
        if (!task || !current || !patch) {
          return { changed: false, task, flow: current };
        }
        assertCurrent();
        const next = applyFlowPatch(current, patch);
        flows.upsertFlow(next);
        return { changed: true, task, flow: next, previous: current };
      },
      "tasks.finalizeActive": (input) =>
        originalCreate(context, { type: "tasks.finalizeActive", input }, assertCurrent, onGranted),
      "flows.createForTask": unsupported,
      "tasks.linkInitialFlow": unsupported,
      "flows.deleteUnlinkedForTask": unsupported,
    };
    return operations[command.type](command.input);
  };
  configureTaskFlowRegistryRuntime({ store: flows });
  configureTaskRegistryRuntime({ store });
  const context = captureOpenClawStateWorkerContext();
  await ensureTaskRegistryReadyAsync(context);
  getTaskFlowById(flow.flowId);
  const create = (
    runtime: TaskRecord["runtime"] = "cli",
    overrides: Partial<
      Pick<
        Parameters<typeof createRunningTaskRunCoreWithReceiptAsync>[0],
        "task" | "childSessionKey" | "parentFlowId"
      >
    > = {},
  ) =>
    createRunningTaskRunCoreWithReceiptAsync({
      runtime,
      scopeKind: "session",
      ownerKey,
      parentFlowId: flow.flowId,
      runId: "committed-run",
      task: "Synthetic linked task",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ...overrides,
    });
  const failSnapshot = () =>
    vi
      .spyOn(store, "loadMutationSnapshotAsync")
      .mockRejectedValueOnce(new Error("Synthetic snapshot read failure"));
  return { flows, store, commands, context, create, failSnapshot, beforeFinalize };
}
