import { err, ok } from "@openclaw/normalization-core/result";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import {
  createExecutionStartedOwnerBinding,
  isRetainedExecutionOwnerBinding,
} from "../../audit/execution-owner-binding.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import { captureTaskCancellationControl } from "../../tasks/task-cancellation-context.js";
import { bindTaskFlowExecution } from "../../tasks/task-flow-registry.store.sqlite.js";
import { bindTaskRunExecution } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { TaskRunOwner } from "../../tasks/task-run-owner.types.js";
import { formatForLog } from "../ws-log.js";
import type { createGatewayAgentRunCancellation } from "./agent-run-cancellation.js";

export function createGatewayTaskExecutionBinding({
  task,
  runId,
  assertCurrent,
  log,
}: {
  task: Pick<TaskRecord, "taskId" | "parentFlowId">;
  runId: string;
  assertCurrent: () => void;
  log: Pick<SubsystemLogger, "warn">;
}) {
  return createExecutionStartedOwnerBinding(async (admitted) => {
    const { taskId, parentFlowId } = task;
    try {
      if (!admitted.executionIdentityToken) {
        return;
      }
      const assertAdmitted = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertAdmitted) {
        throw new Error("Gateway execution authority closed before owner binding");
      }
      const assertBindingCurrent = () => {
        assertCurrent();
        assertAdmitted();
      };
      const context = captureOpenClawStateWorkerContext();
      const taskResult = await bindTaskRunExecution({
        admitted,
        taskId,
        context,
        assertCurrent: assertBindingCurrent,
      });
      const flowResult = parentFlowId
        ? isRetainedExecutionOwnerBinding(taskResult)
          ? await bindTaskFlowExecution({
              admitted,
              flowId: parentFlowId,
              context,
              assertCurrent: assertBindingCurrent,
            })
          : taskResult
        : undefined;
      if (
        [taskResult, flowResult].some((result) => result === "mismatch" || result === "missing")
      ) {
        log.warn(`exact tracked-task execution binding was not retained for ${runId}`);
      }
    } catch (error) {
      log.warn(`failed to retain tracked-task execution binding ${runId}: ${formatForLog(error)}`);
    }
  });
}

/** Preserve the Tasks response projection after native cancellation has fully settled. */
export function createGatewayTaskCancellation(
  task: TaskRecord,
  cancel: ReturnType<typeof createGatewayAgentRunCancellation>,
): TaskRunOwner["cancel"] | undefined {
  if (!cancel) {
    return undefined;
  }
  return async (reason) => {
    const control = captureTaskCancellationControl();
    const outcome = await cancel(reason, () => control?.assertCurrent());
    if (!outcome.ok) {
      return outcome;
    }
    const current = getTaskById(task.taskId);
    return current?.status === "cancelled"
      ? ok(current)
      : err("Task cancellation was not confirmed. Inspect its final result.");
  };
}
