import { cloneTaskDeliveryState } from "./task-registry-records.js";
import {
  bumpTaskRegistryRevision,
  taskDeliveryStates,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import { recordTaskRegistryProjectionWrite } from "./task-registry.process-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskDeliveryState } from "./task-registry.types.js";

/** Install a competing delivery commit for notification and projection interleaving controls. */
export function commitTaskDeliveryFixture(state: TaskDeliveryState): void {
  withTaskRegistryMutation(() => {
    const committed = cloneTaskDeliveryState(state);
    getTaskRegistryStore().upsertDeliveryState(committed);
    taskDeliveryStates.set(committed.taskId, committed);
    recordTaskRegistryProjectionWrite("delivery", committed.taskId);
    bumpTaskRegistryRevision();
  });
}
