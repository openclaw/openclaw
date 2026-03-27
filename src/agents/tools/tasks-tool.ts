import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import {
  createTaskList,
  formatTaskList,
  getTaskList,
  listTaskLists,
  updateTaskStatus,
  type TaskStatus,
} from "../task-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TasksCreateSchema = Type.Object({
  label: Type.String({
    description: "Short name for this task list, e.g. 'March Campaign'",
  }),
  tasks: Type.Array(
    Type.Object({
      subject: Type.String({
        description: "Short imperative title, e.g. 'Audit Shopee ads ROAS'",
      }),
      description: Type.String({
        description: "Full detail of what needs to be done",
      }),
      agentId: Type.String({
        description: "Which agent handles this task (e.g. mars, john, vulcan)",
      }),
    }),
    { minItems: 1 },
  ),
});

const TasksListSchema = Type.Object({
  listId: Type.Optional(
    Type.String({
      description: "ID of a specific task list. Omit to show all recent lists.",
    }),
  ),
});

const TASK_STATUSES = ["pending", "in_progress", "done", "failed", "skipped"] as const;

const TasksUpdateSchema = Type.Object({
  taskId: Type.String({ description: "UUID of the task to update" }),
  status: stringEnum(TASK_STATUSES, {
    description: "New status for the task",
  }),
  result: Type.Optional(Type.String({ description: "Optional result summary (max 500 chars)" })),
});

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

interface TasksToolOpts {
  agentSessionKey?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTasksTool(opts?: TasksToolOpts): AnyAgentTool[] {
  return [createTasksCreateTool(opts), createTasksListTool(opts), createTasksUpdateTool(opts)];
}

// ---------------------------------------------------------------------------
// tasks_create
// ---------------------------------------------------------------------------

function createTasksCreateTool(opts?: TasksToolOpts): AnyAgentTool {
  return {
    label: "Tasks",
    name: "tasks_create",
    description:
      "Create a task checklist for tracking work delegated to agents. " +
      "Returns a listId that you MUST include in the mission label as 'listId:<id>:<label>' " +
      "so task completion is auto-tracked when the mission finishes.",
    parameters: TasksCreateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const label = readStringParam(params, "label", { required: true });
      const tasksRaw = params.tasks;

      if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
        return jsonResult({ error: "At least one task is required" });
      }

      const tasks = tasksRaw.map((t: Record<string, unknown>) => ({
        subject: readStringParam(t, "subject", { required: true }),
        description: readStringParam(t, "description", { required: true }),
        agentId: readStringParam(t, "agentId", { required: true }),
      }));

      const result = createTaskList({
        label,
        tasks,
        requesterSessionKey: opts?.agentSessionKey ?? "unknown",
      });

      // Format checklist for LLM display
      const list = getTaskList(result.listId);
      const formatted = list ? formatTaskList(list) : "";

      return jsonResult({
        status: "created",
        listId: result.listId,
        taskCount: result.tasks.length,
        missionLabelPrefix: `listId:${result.listId}:${label}`,
        checklist: formatted,
        hint: `Use "listId:${result.listId}:${label}" as the mission label to enable auto-tracking.`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// tasks_list
// ---------------------------------------------------------------------------

function createTasksListTool(opts?: TasksToolOpts): AnyAgentTool {
  return {
    label: "Tasks",
    name: "tasks_list",
    description:
      "Show the current status of a task checklist. " +
      "If listId is provided, shows that specific list. " +
      "Otherwise shows all recent task lists.",
    parameters: TasksListSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const listId = readStringParam(params, "listId");

      if (listId) {
        const list = getTaskList(listId);
        if (!list) {
          return jsonResult({ error: `Task list ${listId} not found` });
        }
        return jsonResult({
          checklist: formatTaskList(list),
          listId: list.listId,
          label: list.label,
          total: list.tasks.size,
          done: [...list.tasks.values()].filter((t) => t.status === "done").length,
        });
      }

      // Show all recent lists
      const lists = listTaskLists(opts?.agentSessionKey);
      if (lists.length === 0) {
        return jsonResult({ message: "No task lists found." });
      }

      const summaries = lists
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((l) => formatTaskList(l));

      return jsonResult({
        count: summaries.length,
        checklists: summaries.join("\n\n---\n\n"),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// tasks_update
// ---------------------------------------------------------------------------

function createTasksUpdateTool(_opts?: TasksToolOpts): AnyAgentTool {
  return {
    label: "Tasks",
    name: "tasks_update",
    description:
      "Manually update the status of a task or close an entire task list. " +
      "Pass a taskId UUID to update an individual task, or pass a listId UUID to close the whole list (status 'done'→completed, 'failed'→failed, otherwise partial). " +
      "Use this when auto-tracking is not available or to override a status.",
    parameters: TasksUpdateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const taskId = readStringParam(params, "taskId", { required: true });
      const status = readStringParam(params, "status", { required: true }) as TaskStatus;
      const result = readStringParam(params, "result");

      const updated = updateTaskStatus(taskId, status, result);
      if (!updated) {
        return jsonResult({ error: `Task or list ${taskId} not found` });
      }

      // Check if this was a list update (listId) or task update (taskId)
      const list = getTaskList(taskId);
      if (list) {
        return jsonResult({
          status: "updated",
          listId: taskId,
          listStatus: status === "done" ? "completed" : status === "failed" ? "failed" : "partial",
          newStatus: status,
          message: `Task list "${list.label}" closed with status: ${status}`,
        });
      }

      return jsonResult({
        status: "updated",
        taskId,
        newStatus: status,
      });
    },
  };
}
