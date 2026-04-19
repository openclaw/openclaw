import type { cancelTaskById } from "./runtime-internal.js";
import type {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";

export type DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: typeof createQueuedTaskRun;
  createRunningTaskRun: typeof createRunningTaskRun;
  startTaskRunByRunId: typeof startTaskRunByRunId;
  recordTaskRunProgressByRunId: typeof recordTaskRunProgressByRunId;
  completeTaskRunByRunId: typeof completeTaskRunByRunId;
  failTaskRunByRunId: typeof failTaskRunByRunId;
  setDetachedTaskDeliveryStatusByRunId: typeof setDetachedTaskDeliveryStatusByRunId;
  cancelDetachedTaskRunById: typeof cancelTaskById;
};

export type DetachedTaskLifecycleRuntimeRegistration = {
  pluginId: string;
  runtime: DetachedTaskLifecycleRuntime;
};

let detachedTaskLifecycleRuntimeRegistration: DetachedTaskLifecycleRuntimeRegistration | undefined;

export function registerDetachedTaskLifecycleRuntime(
  pluginId: string,
  runtime: DetachedTaskLifecycleRuntime,
): void {
  detachedTaskLifecycleRuntimeRegistration = {
    pluginId,
    runtime,
  };
}

export function getDetachedTaskLifecycleRuntimeRegistration():
  | DetachedTaskLifecycleRuntimeRegistration
  | undefined {
  if (!detachedTaskLifecycleRuntimeRegistration) {
    return undefined;
  }
  return {
    pluginId: detachedTaskLifecycleRuntimeRegistration.pluginId,
    runtime: detachedTaskLifecycleRuntimeRegistration.runtime,
  };
}

export function getRegisteredDetachedTaskLifecycleRuntime():
  | DetachedTaskLifecycleRuntime
  | undefined {
  return detachedTaskLifecycleRuntimeRegistration?.runtime;
}

export function restoreDetachedTaskLifecycleRuntimeRegistration(
  registration: DetachedTaskLifecycleRuntimeRegistration | undefined,
): void {
  detachedTaskLifecycleRuntimeRegistration = registration
    ? {
        pluginId: registration.pluginId,
        runtime: registration.runtime,
      }
    : undefined;
}

export function clearDetachedTaskLifecycleRuntimeRegistration(): void {
  detachedTaskLifecycleRuntimeRegistration = undefined;
}

export const _resetDetachedTaskLifecycleRuntimeRegistration =
  clearDetachedTaskLifecycleRuntimeRegistration;
