import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import { getSubagentExecutionObservation } from "../agents/subagents/registry/subagent-execution-observation.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { getTaskActivitySnapshot } from "./task-registry-activity.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { sanitizeTaskStatusText, TASK_STATUS_DETAIL_MAX_CHARS } from "./task-status.js";

function sanitizeOptionalTaskText(value: unknown): string | undefined {
  return sanitizeTaskStatusText(value, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }) || undefined;
}

/** One runtime observation for Gateway inspection and model-facing task controls. */
export function getTaskExecutionObservation(
  task: TaskRecord,
): NonNullable<TaskSummary["execution"]> {
  const activity = getTaskActivitySnapshot(task.taskId);
  const backing = readTaskBackingInstance(task.detail);
  const registeredExecution =
    task.runtime === "subagent" && task.runId && task.childSessionKey
      ? getSubagentExecutionObservation({
          taskRunId: task.runId,
          childSessionKey: task.childSessionKey,
          ...(backing?.runtime === "subagent" ? { generation: backing.generation } : {}),
        })
      : undefined;
  const nativeExecution = registeredExecution
    ? {
        state: registeredExecution.state,
        ...(registeredExecution.wait ? { wait: registeredExecution.wait } : {}),
      }
    : undefined;
  const currentActivity =
    (backing?.runtime === "subagent" && !registeredExecution) ||
    (registeredExecution && activity?.executionRunId !== registeredExecution.executionRunId)
      ? undefined
      : activity;
  const execution: NonNullable<TaskSummary["execution"]> =
    task.status === "lost"
      ? { state: "unknown" }
      : isTerminalTaskStatus(task.status)
        ? { state: "finished" }
        : task.status === "queued"
          ? { state: "queued" }
          : (nativeExecution ?? {
              state: currentActivity?.executionState ?? "unknown",
              ...(currentActivity?.executionWait ? { wait: currentActivity.executionWait } : {}),
            });
  if (execution.state === "running" && currentActivity?.executionWait) {
    execution.state = currentActivity.executionState ?? "waiting";
    execution.wait = currentActivity.executionWait;
  }
  if (activity?.lastActivityAt !== undefined) {
    execution.lastActivityAt = activity.lastActivityAt;
  }
  const currentToolName = sanitizeOptionalTaskText(currentActivity?.currentTool?.name);
  if (execution.state === "running" && currentToolName && currentActivity?.currentTool) {
    execution.currentTool = {
      name: currentToolName,
      startedAt: currentActivity.currentTool.startedAt,
    };
  }
  if (execution.wait?.dependencies) {
    execution.wait.dependencies = execution.wait.dependencies
      .slice(0, 100)
      .map((dependency) =>
        Object.assign({}, dependency, { label: sanitizeOptionalTaskText(dependency.label) }),
      );
  }
  return execution;
}
