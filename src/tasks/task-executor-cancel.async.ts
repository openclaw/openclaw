import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { captureDetachedTaskRuntimeOwner } from "./detached-task-runtime-state.js";
import { prepareTaskBackingRead } from "./task-backing-authority.js";
import {
  prepareTaskCancellationControl,
  withTaskCancellationContext,
  withTaskCancellationControl,
} from "./task-cancellation-context.js";
import { captureTaskCancellationSelection } from "./task-cancellation-selection.capture.js";
import { matchesTaskCancellationSelection } from "./task-cancellation-selection.js";
import { cancelTaskById, type TaskCancellationResult } from "./task-registry-cancel.js";
import { tasks } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

/** Flow callers retain the exact child and runtime owner across worker preparation. */
export async function cancelDetachedTaskRunByIdAsync(
  params: { cfg: OpenClawConfig; taskId: string; reason?: string },
  authority: { selectedTask: TaskRecord; assertCurrent: () => void },
): Promise<TaskCancellationResult> {
  const owner = captureDetachedTaskRuntimeOwner({ settlement: true });
  const selection = captureTaskCancellationSelection(authority.selectedTask);
  const selected = selection.task;
  const selectedRunOwner = getTaskRunOwner(selected);
  const assertCurrent = () => {
    owner.assertCurrent();
    authority.assertCurrent();
  };
  try {
    assertCurrent();
    const read = await prepareTaskBackingRead(params.taskId);
    assertCurrent();
    const task = read?.getTaskById(params.taskId);
    if (!task || !matchesTaskCancellationSelection(task, selected)) {
      return {
        found: Boolean(task),
        cancelled: false,
        reason: "Task changed while cancellation was in progress.",
        task,
      };
    }
    const assertSelected = () => {
      assertCurrent();
      const current = tasks.get(selected.taskId);
      if (
        !current ||
        !matchesTaskCancellationSelection(current, selected) ||
        getTaskRunOwner(current) !== selectedRunOwner
      ) {
        throw new Error("Task changed while cancellation was in progress.");
      }
    };
    return await withTaskCancellationContext(
      assertSelected,
      async () => {
        const runtime = owner.runtime;
        if (runtime) {
          const inherited = prepareTaskCancellationControl(task);
          const control = {
            prepareRead: inherited?.prepareRead,
            assertCurrent() {
              inherited?.assertCurrent();
              assertSelected();
            },
          };
          control.assertCurrent();
          const result = await withTaskCancellationControl(control, () =>
            runtime.cancelDetachedTaskRunById(params),
          );
          control.assertCurrent();
          if (result.found) {
            return result;
          }
        }
        assertCurrent();
        return cancelTaskById(params);
      },
      { selectedTask: task },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { found: true, cancelled: false, reason: formatErrorMessage(error) };
  } finally {
    selection.release();
  }
}
