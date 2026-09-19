import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import { getActiveBackgroundExecSession } from "../agents/bash-process-registry.js";
import { getSubagentExecutionObservation } from "../agents/subagents/registry/subagent-execution-observation.js";
import { isAgentRunWaitingForCapacity } from "../infra/agent-run-capacity-wait.js";
import { getAgentRunContext, hasLiveAgentRunContext } from "../infra/agent-run-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isBackgroundExecTask } from "./background-exec-task-contract.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { getTaskActivitySnapshot } from "./task-registry-activity.js";
import { resolveTaskAgentId } from "./task-registry-records.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { sanitizeTaskStatusText, TASK_STATUS_DETAIL_MAX_CHARS } from "./task-status.js";

function sanitizeOptionalTaskText(value: unknown): string | undefined {
  return sanitizeTaskStatusText(value, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }) || undefined;
}

function observeCliExecution(task: TaskRecord): "queued" | "running" | undefined {
  if (task.runtime !== "cli" || !task.runId) {
    return undefined;
  }
  const context = getAgentRunContext(task.runId);
  const sessionKey =
    task.childSessionKey ?? (task.scopeKind === "session" ? task.ownerKey : undefined);
  if (
    !context ||
    !sessionKey ||
    context.sessionKey !== sessionKey ||
    !hasLiveAgentRunContext(task.runId)
  ) {
    return undefined;
  }
  const agentId = context.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  const taskAgentId = resolveTaskAgentId(task);
  if (taskAgentId && (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(taskAgentId))) {
    return undefined;
  }
  return isAgentRunWaitingForCapacity(task.runId) ? "queued" : "running";
}

/** One runtime observation for Gateway inspection and model-facing task controls. */
export function getTaskExecutionObservation(
  task: TaskRecord,
): NonNullable<TaskSummary["execution"]> {
  const activity = getTaskActivitySnapshot(task.taskId);
  const fixedState =
    task.status === "lost"
      ? "unknown"
      : isTerminalTaskStatus(task.status)
        ? "finished"
        : task.status === "queued" && task.runtime !== "subagent"
          ? "queued"
          : undefined;
  if (fixedState) {
    return {
      state: fixedState,
      ...(activity?.lastActivityAt !== undefined
        ? { lastActivityAt: activity.lastActivityAt }
        : {}),
    };
  }
  if (isBackgroundExecTask(task)) {
    const process = task.sourceId ? getActiveBackgroundExecSession(task.sourceId) : undefined;
    // Process ids may be reused after retention/restart; the recorded launch and
    // session must still match. Silence alone never proves a stopped or waiting command.
    if (!process || process.startedAt !== task.startedAt || process.sessionKey !== task.ownerKey) {
      return { state: "unknown" };
    }
    const finalizing = process.finalizing || process.processActivity?.resultSettled;
    return {
      state: finalizing ? "waiting" : "running",
      ...(finalizing ? { wait: { kind: "external" } as const } : {}),
      lastActivityAt: Math.max(
        process.processActivity?.lastOutputAtMs ?? process.startedAt,
        activity?.lastActivityAt ?? 0,
      ),
    };
  }
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
  const execution: NonNullable<TaskSummary["execution"]> = nativeExecution ?? {
    // An explicit unknown state must not be replaced with inferred liveness.
    state: currentActivity?.executionState ?? observeCliExecution(task) ?? "unknown",
    ...(currentActivity?.executionWait ? { wait: currentActivity.executionWait } : {}),
  };
  if (
    execution.state === "running" &&
    (currentActivity?.executionState || currentActivity?.executionWait)
  ) {
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
