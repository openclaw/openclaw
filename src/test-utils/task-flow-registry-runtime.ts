import {
  configureFlowRegistryRuntime,
  type FlowRegistryStore,
  type FlowRegistryStoreSnapshot,
} from "../tasks/flow-registry.store.js";
import type { FlowRecord } from "../tasks/flow-registry.types.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryStore,
  type TaskRegistryStoreSnapshot,
} from "../tasks/task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";

function cloneTask(task: TaskRecord): TaskRecord {
  return { ...task };
}

function cloneDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

function cloneFlow(flow: FlowRecord): FlowRecord {
  return {
    ...flow,
    ...(flow.requesterOrigin ? { requesterOrigin: { ...flow.requesterOrigin } } : {}),
  };
}

export function installInMemoryTaskAndFlowRegistryRuntime(): {
  taskStore: TaskRegistryStore;
  flowStore: FlowRegistryStore;
} {
  let taskSnapshot: TaskRegistryStoreSnapshot = {
    tasks: new Map<string, TaskRecord>(),
    deliveryStates: new Map<string, TaskDeliveryState>(),
  };
  let flowSnapshot: FlowRegistryStoreSnapshot = {
    flows: new Map<string, FlowRecord>(),
  };

  const taskStore: TaskRegistryStore = {
    loadSnapshot: () => ({
      tasks: new Map(
        [...taskSnapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
      ),
      deliveryStates: new Map(
        [...taskSnapshot.deliveryStates.entries()].map(([taskId, state]) => [
          taskId,
          cloneDeliveryState(state),
        ]),
      ),
    }),
    saveSnapshot: (snapshot) => {
      taskSnapshot = {
        tasks: new Map(
          [...snapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
        ),
        deliveryStates: new Map(
          [...snapshot.deliveryStates.entries()].map(([taskId, state]) => [
            taskId,
            cloneDeliveryState(state),
          ]),
        ),
      };
    },
    upsertTask: (task) => {
      taskSnapshot.tasks.set(task.taskId, cloneTask(task));
    },
    deleteTask: (taskId) => {
      taskSnapshot.tasks.delete(taskId);
    },
    upsertDeliveryState: (state) => {
      taskSnapshot.deliveryStates.set(state.taskId, cloneDeliveryState(state));
    },
    deleteDeliveryState: (taskId) => {
      taskSnapshot.deliveryStates.delete(taskId);
    },
  };

  const flowStore: FlowRegistryStore = {
    loadSnapshot: () => ({
      flows: new Map(
        [...flowSnapshot.flows.entries()].map(([flowId, flow]) => [flowId, cloneFlow(flow)]),
      ),
    }),
    saveSnapshot: (snapshot) => {
      flowSnapshot = {
        flows: new Map(
          [...snapshot.flows.entries()].map(([flowId, flow]) => [flowId, cloneFlow(flow)]),
        ),
      };
    },
    upsertFlow: (flow) => {
      flowSnapshot.flows.set(flow.flowId, cloneFlow(flow));
    },
    deleteFlow: (flowId) => {
      flowSnapshot.flows.delete(flowId);
    },
  };

  configureTaskRegistryRuntime({ store: taskStore });
  configureFlowRegistryRuntime({ store: flowStore });
  return { taskStore, flowStore };
}
