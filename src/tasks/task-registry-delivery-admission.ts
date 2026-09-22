import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../process/gateway-work-admission.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  assertTaskRegistryRestoreNotFailed,
  taskRegistryLog,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export function runTaskDeliveryWithDetachedAdmission(
  taskId: string,
  deliver: (assertCurrent: () => void) => Promise<TaskRecord | null>,
): Promise<TaskRecord | null> {
  const pending = runAdmittedTaskDelivery(taskId, deliver);
  // Entry points return this exact promise: background failures are reported; awaited calls reject.
  void pending.catch((error: unknown) => {
    taskRegistryLog.warn("Background task notification failed", { taskId, error });
  });
  return pending;
}

async function runAdmittedTaskDelivery(
  taskId: string,
  deliver: (assertCurrent: () => void) => Promise<TaskRecord | null>,
): Promise<TaskRecord | null> {
  let admitted = false;
  try {
    return await runWithGatewayDetachedWorkContinuation(async () => {
      admitted = true;
      const restartSignal = getGatewayRestartDrainSignal();
      let active = true;
      try {
        return await deliver(() => {
          if (!active || getGatewayRestartDrainSignal() !== restartSignal) {
            throw new Error("Task delivery no longer owns its Gateway continuation");
          }
        });
      } finally {
        active = false;
      }
    }, "tasks:delivery");
  } catch (error) {
    // Late lifecycle callbacks must not leak a rejected detached promise after
    // restart closes admission. An already-admitted delivery still reports its
    // own failures instead of hiding them behind a concurrent restart.
    if (!admitted && isGatewayRestartDraining()) {
      assertTaskRegistryRestoreNotFailed();
      const current = tasks.get(taskId);
      return current ? cloneTaskRecord(current) : null;
    }
    throw error;
  }
}
