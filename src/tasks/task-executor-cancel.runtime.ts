// Lazy runtime boundary for task cancellation and its runtime-specific control stack.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import {
  assertTaskCancellationReadyById,
  cancelTaskById,
  getTaskById,
} from "./runtime-internal.js";
import {
  prepareTaskCancellationControl,
  prepareTaskCancellationRead,
} from "./task-cancellation-context.js";

export async function cancelDetachedTaskRunByIdCore(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}) {
  for (
    let pending = prepareTaskCancellationRead();
    pending;
    pending = prepareTaskCancellationRead()
  ) {
    await pending;
  }
  const task = getTaskById(params.taskId);
  const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
  try {
    prepareTaskCancellationControl(task)?.assertCurrent();
  } catch (error) {
    return {
      found: task !== undefined,
      cancelled: false,
      reason: formatErrorMessage(error),
      ...(task ? { task } : {}),
    };
  }
  if (task) {
    try {
      assertTaskCancellationReadyById(task.taskId);
    } catch (error) {
      return {
        found: true,
        cancelled: false,
        reason: formatErrorMessage(error),
        task,
      };
    }
  }
  if (registeredRuntime) {
    const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
    if (cancelled.found) {
      return cancelled;
    }
  }
  return cancelTaskById(params);
}
