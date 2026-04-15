import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cancelTaskById,
  createTaskRecord,
  getTaskById,
  listTaskRecords,
  markTaskTerminalById,
  resolveTaskForLookupToken,
  setTaskProgressById,
  updateTaskNotifyPolicyById,
} from "../../tasks/task-registry.js";
import type { TaskNotifyPolicy, TaskRuntime, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

const TASK_ACTIONS = ["create", "get", "list", "stop", "update", "output"] as const;
const TASK_RUNTIMES: TaskRuntime[] = ["cli", "acp", "subagent", "cron"];
const TASK_NOTIFY_POLICIES: TaskNotifyPolicy[] = ["done_only", "state_changes", "silent"];
const TASK_TERMINAL_STATUSES: Array<Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">> =
  ["succeeded", "failed", "timed_out", "cancelled"];

export const TaskToolSchema = Type.Object(
  {
    action: Type.Union(TASK_ACTIONS.map((entry) => Type.Literal(entry))),
    taskId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    lookup: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    runtime: Type.Optional(Type.Union(TASK_RUNTIMES.map((entry) => Type.Literal(entry)))),
    status: Type.Optional(Type.String()),
    notifyPolicy: Type.Optional(Type.Union(TASK_NOTIFY_POLICIES.map((entry) => Type.Literal(entry)))),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    ownerKey: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: true },
);

type TaskToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
};

function normalizeRuntime(value: string | undefined): TaskRuntime {
  const runtime = value?.trim().toLowerCase();
  if (!runtime) {
    return "cli";
  }
  if (TASK_RUNTIMES.includes(runtime as TaskRuntime)) {
    return runtime as TaskRuntime;
  }
  throw new ToolInputError(`invalid runtime: ${value}`);
}

function normalizeTerminalStatus(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (TASK_TERMINAL_STATUSES.includes(normalized as (typeof TASK_TERMINAL_STATUSES)[number])) {
    return normalized as (typeof TASK_TERMINAL_STATUSES)[number];
  }
  throw new ToolInputError(
    `unsupported status for update: ${value} (allowed: ${TASK_TERMINAL_STATUSES.join(", ")})`,
  );
}

function resolveLookupToken(params: Record<string, unknown>) {
  return (
    readStringParam(params, "lookup") ??
    readStringParam(params, "taskId") ??
    readStringParam(params, "runId")
  );
}

function buildTaskOutput(task: ReturnType<typeof getTaskById>) {
  if (!task) {
    return null;
  }
  return {
    taskId: task.taskId,
    status: task.status,
    progressSummary: task.progressSummary ?? null,
    terminalSummary: task.terminalSummary ?? null,
    terminalOutcome: task.terminalOutcome ?? null,
    error: task.error ?? null,
    lastEventAt: task.lastEventAt ?? null,
  };
}

export function createTaskTool(options?: TaskToolOptions): AnyAgentTool {
  return {
    name: "task",
    label: "task",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("task"),
    description:
      "Manage task runtime records (create/get/list/stop/update/output) for background work tracking.",
    parameters: TaskToolSchema,
    execute: async (_toolCallId, input) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as
        | "create"
        | "get"
        | "list"
        | "stop"
        | "update"
        | "output";

      if (action === "create") {
        const task = readStringParam(params, "task", { required: true, label: "task" });
        const requesterSessionKey =
          readStringParam(params, "sessionKey") ?? options?.agentSessionKey ?? "";
        const record = createTaskRecord({
          runtime: normalizeRuntime(readStringParam(params, "runtime")),
          task,
          label: readStringParam(params, "label"),
          requesterSessionKey,
          ownerKey: readStringParam(params, "ownerKey"),
          scopeKind: requesterSessionKey.trim() ? "session" : "system",
        });
        return jsonResult({ status: "ok", action, task: record });
      }

      if (action === "get") {
        const lookup = resolveLookupToken(params);
        if (!lookup) {
          throw new ToolInputError("lookup required (lookup|taskId|runId)");
        }
        const task = resolveTaskForLookupToken(lookup);
        if (!task) {
          throw new ToolInputError(`task not found: ${lookup}`);
        }
        return jsonResult({ status: "ok", action, task });
      }

      if (action === "list") {
        const runtimeFilter = readStringParam(params, "runtime");
        const statusFilter = readStringParam(params, "status");
        const ownerKey = readStringParam(params, "ownerKey");
        const limit = readNumberParam(params, "limit", { integer: true });
        const tasks = listTaskRecords()
          .filter((entry) => (runtimeFilter ? entry.runtime === normalizeRuntime(runtimeFilter) : true))
          .filter((entry) => (statusFilter ? entry.status === statusFilter : true))
          .filter((entry) => (ownerKey ? entry.ownerKey === ownerKey : true))
          .slice(0, typeof limit === "number" ? Math.max(1, limit) : 50);
        return jsonResult({
          status: "ok",
          action,
          count: tasks.length,
          tasks,
        });
      }

      if (action === "stop") {
        const taskId = readStringParam(params, "taskId", { required: true, label: "taskId" });
        if (!options?.config) {
          throw new ToolInputError("task stop requires gateway config runtime");
        }
        const result = await cancelTaskById({
          cfg: options.config,
          taskId,
        });
        return jsonResult({
          status: "ok",
          action,
          ...result,
        });
      }

      if (action === "update") {
        const taskId = readStringParam(params, "taskId", { required: true, label: "taskId" });
        let updated = getTaskById(taskId);
        if (!updated) {
          throw new ToolInputError(`task not found: ${taskId}`);
        }

        const notifyPolicy = readStringParam(params, "notifyPolicy");
        if (notifyPolicy) {
          if (!TASK_NOTIFY_POLICIES.includes(notifyPolicy as TaskNotifyPolicy)) {
            throw new ToolInputError(`invalid notifyPolicy: ${notifyPolicy}`);
          }
          updated = updateTaskNotifyPolicyById({
            taskId,
            notifyPolicy: notifyPolicy as TaskNotifyPolicy,
          });
        }

        const progressSummary = readStringParam(params, "progressSummary", { allowEmpty: true });
        if (progressSummary !== undefined) {
          updated = setTaskProgressById({
            taskId,
            progressSummary: progressSummary || null,
            lastEventAt: Date.now(),
          });
        }

        const terminalStatus = normalizeTerminalStatus(readStringParam(params, "status"));
        if (terminalStatus) {
          updated = markTaskTerminalById({
            taskId,
            status: terminalStatus,
            endedAt: Date.now(),
            ...(readStringParam(params, "error") ? { error: readStringParam(params, "error") } : {}),
            ...(readStringParam(params, "terminalSummary", { allowEmpty: true }) !== undefined
              ? { terminalSummary: readStringParam(params, "terminalSummary", { allowEmpty: true }) || null }
              : {}),
          });
        }

        if (!updated) {
          throw new ToolInputError(`task not found: ${taskId}`);
        }

        return jsonResult({
          status: "ok",
          action,
          task: updated,
        });
      }

      const taskId = readStringParam(params, "taskId", { required: true, label: "taskId" });
      const task = getTaskById(taskId);
      if (!task) {
        throw new ToolInputError(`task not found: ${taskId}`);
      }
      return jsonResult({
        status: "ok",
        action,
        output: buildTaskOutput(task),
      });
    },
  };
}
