import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  getSessionPlanState,
  getSessionRuntimeMode,
  setSessionRuntimeMode,
  SESSION_PLAN_TODO_STATUSES,
  type SessionPlanState,
  type SessionPlanTodo,
  updateSessionPlanState,
} from "../../config/sessions.js";
import { createTaskRecord, getTaskById, updateTaskStateById } from "../../tasks/task-registry.js";
import type { TaskStatus, TaskTerminalOutcome } from "../../tasks/task-registry.types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  describeEnterPlanModeTool,
  describeExitPlanModeTool,
  describeTaskCreateTool,
  describeTaskUpdateTool,
  describeTodoWriteTool,
  ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
  EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
  TASK_CREATE_TOOL_DISPLAY_SUMMARY,
  TASK_UPDATE_TOOL_DISPLAY_SUMMARY,
  TODO_WRITE_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import {
  jsonResult,
  readStringParam,
  type AnyAgentTool,
  ToolInputError,
  textResult,
} from "./common.js";

const TaskCreateStatusValues = ["queued", "running"] as const;
const TaskUpdateStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
const TaskTerminalOutcomeValues = ["succeeded", "blocked"] as const;

const PlanTodoSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    status: stringEnum(SESSION_PLAN_TODO_STATUSES, {
      description: 'One of "pending", "in_progress", "done", or "skipped".',
    }),
  },
  { additionalProperties: false },
);

const TodoWriteToolSchema = Type.Object(
  {
    content: Type.Optional(Type.String()),
    todos: Type.Optional(Type.Array(PlanTodoSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);

const TaskCreateToolSchema = Type.Object(
  {
    todoId: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    taskKind: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    status: Type.Optional(stringEnum(TaskCreateStatusValues)),
  },
  { additionalProperties: false },
);

const TaskUpdateToolSchema = Type.Object(
  {
    taskId: Type.String(),
    status: Type.Optional(stringEnum(TaskUpdateStatusValues)),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    terminalOutcome: Type.Optional(stringEnum(TaskTerminalOutcomeValues)),
  },
  { additionalProperties: false },
);

function requireSessionKey(agentSessionKey?: string): string {
  const sessionKey = agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("agentSessionKey unavailable for plan mode tool");
  }
  return sessionKey;
}

function readTodos(params: Record<string, unknown>): SessionPlanTodo[] | undefined {
  const rawTodos = params.todos;
  if (rawTodos === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
    throw new ToolInputError("todos must include at least one item");
  }
  return rawTodos.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError(`todos[${index}] must be an object`);
    }
    const todo = entry as Record<string, unknown>;
    const id = readStringParam(todo, "id", {
      required: true,
      label: `todos[${index}].id`,
    });
    const text = readStringParam(todo, "text", {
      required: true,
      label: `todos[${index}].text`,
    });
    const status = readStringParam(todo, "status", {
      required: true,
      label: `todos[${index}].status`,
    });
    if (!SESSION_PLAN_TODO_STATUSES.includes(status as SessionPlanTodo["status"])) {
      throw new ToolInputError(
        `todos[${index}].status must be one of ${SESSION_PLAN_TODO_STATUSES.join(", ")}`,
      );
    }
    return {
      id,
      text,
      status: status as SessionPlanTodo["status"],
    };
  });
}

function readPlanContent(params: Record<string, unknown>): string | undefined {
  const raw = params.content;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ToolInputError("content must be a string");
  }
  const content = raw.trim();
  if (!content) {
    throw new ToolInputError("content must not be empty");
  }
  return content;
}

function resolveTaskStatus(raw: string | undefined): TaskStatus | undefined {
  if (!raw) {
    return undefined;
  }
  return raw as TaskStatus;
}

function resolveTerminalOutcome(
  raw: string | undefined,
): TaskTerminalOutcome | undefined {
  if (!raw) {
    return undefined;
  }
  return raw as TaskTerminalOutcome;
}

function mergePlanState(params: {
  current: SessionPlanState | undefined;
  content?: string;
  todos?: SessionPlanTodo[];
  now: number;
}): SessionPlanState {
  return {
    ...params.current,
    ...(params.content !== undefined ? { content: params.content } : {}),
    ...(params.todos !== undefined ? { todos: params.todos } : {}),
    enteredAt: params.current?.enteredAt ?? params.now,
    updatedAt: params.now,
  };
}

type PlanToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
};

export function createEnterPlanModeTool(opts?: PlanToolOptions): AnyAgentTool {
  return {
    label: "Enter Plan Mode",
    name: "enter_plan_mode",
    displaySummary: ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
    description: describeEnterPlanModeTool(),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = requireSessionKey(opts?.agentSessionKey);
      const now = Date.now();
      await setSessionRuntimeMode(sessionKey, "plan", cfg);
      const state = await updateSessionPlanState({
        sessionKey,
        cfg,
        mutate: () => ({
          enteredAt: now,
          updatedAt: now,
        }),
      });
      return textResult("Plan mode enabled.", {
        status: "enabled" as const,
        sessionKey,
        runtimeMode: "plan" as const,
        planState: state?.planState ?? { enteredAt: now, updatedAt: now },
      });
    },
  };
}

export function createExitPlanModeTool(opts?: PlanToolOptions): AnyAgentTool {
  return {
    label: "Exit Plan Mode",
    name: "exit_plan_mode",
    displaySummary: EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY,
    description: describeExitPlanModeTool(),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = requireSessionKey(opts?.agentSessionKey);
      const now = Date.now();
      await updateSessionPlanState({
        sessionKey,
        cfg,
        mutate: (current) => ({
          ...current,
          confirmedAt: now,
          updatedAt: now,
        }),
      });
      const state = await setSessionRuntimeMode(sessionKey, "normal", cfg);
      return textResult("Plan mode disabled.", {
        status: "disabled" as const,
        sessionKey,
        runtimeMode: "normal" as const,
        planState: state?.planState ?? { confirmedAt: now, updatedAt: now },
      });
    },
  };
}

export function createTodoWriteTool(opts?: PlanToolOptions): AnyAgentTool {
  return {
    label: "Todo Write",
    name: "todo_write",
    displaySummary: TODO_WRITE_TOOL_DISPLAY_SUMMARY,
    description: describeTodoWriteTool(),
    parameters: TodoWriteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = requireSessionKey(opts?.agentSessionKey);
      const content = readPlanContent(params);
      const todos = readTodos(params);
      if (content === undefined && todos === undefined) {
        throw new ToolInputError("todo_write requires content or todos");
      }
      const now = Date.now();
      const state = await updateSessionPlanState({
        sessionKey,
        cfg,
        mutate: (current) =>
          mergePlanState({
            current,
            content,
            todos,
            now,
          }),
      });
      return textResult("Plan persisted.", {
        status: "updated" as const,
        sessionKey,
        runtimeMode: getSessionRuntimeMode(sessionKey, cfg) ?? "auto",
        planState: state?.planState,
      });
    },
  };
}

export function createTaskCreateTool(opts?: PlanToolOptions): AnyAgentTool {
  return {
    label: "Task Create",
    name: "task_create",
    displaySummary: TASK_CREATE_TOOL_DISPLAY_SUMMARY,
    description: describeTaskCreateTool(),
    parameters: TaskCreateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = requireSessionKey(opts?.agentSessionKey);
      const todoId = readStringParam(params, "todoId");
      const explicitTask = readStringParam(params, "task");
      const label = readStringParam(params, "label");
      const taskKind = readStringParam(params, "taskKind");
      const sourceId = readStringParam(params, "sourceId");
      const status = resolveTaskStatus(readStringParam(params, "status")) ?? "queued";
      const todo =
        todoId === undefined ? undefined : getSessionPlanState(sessionKey, cfg)?.todos?.find((item) => item.id === todoId);

      if (!explicitTask && todoId && !todo) {
        throw new ToolInputError(`todoId not found in persisted plan: ${todoId}`);
      }

      const task = explicitTask ?? todo?.text;
      if (!task) {
        throw new ToolInputError("task_create requires task or todoId");
      }

      const created = createTaskRecord({
        runtime: "cli",
        taskKind: taskKind ?? "plan",
        sourceId: sourceId ?? todoId,
        requesterSessionKey: sessionKey,
        ownerKey: sessionKey,
        scopeKind: "session",
        label: label ?? todo?.text,
        task,
        status,
        notifyPolicy: "silent",
      });

      return textResult("Task created.", {
        status: "created" as const,
        sessionKey,
        ...(todoId ? { todoId } : {}),
        task: created,
      });
    },
  };
}

export function createTaskUpdateTool(opts?: PlanToolOptions): AnyAgentTool {
  return {
    label: "Task Update",
    name: "task_update",
    displaySummary: TASK_UPDATE_TOOL_DISPLAY_SUMMARY,
    description: describeTaskUpdateTool(),
    parameters: TaskUpdateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = requireSessionKey(opts?.agentSessionKey);
      const taskId = readStringParam(params, "taskId", { required: true });
      const status = resolveTaskStatus(readStringParam(params, "status"));
      const progressSummary = readStringParam(params, "progressSummary");
      const terminalSummary = readStringParam(params, "terminalSummary");
      const error = readStringParam(params, "error");
      const terminalOutcome = resolveTerminalOutcome(readStringParam(params, "terminalOutcome"));
      if (
        status === undefined &&
        progressSummary === undefined &&
        terminalSummary === undefined &&
        error === undefined &&
        terminalOutcome === undefined
      ) {
        throw new ToolInputError(
          "task_update requires status, progressSummary, terminalSummary, error, or terminalOutcome",
        );
      }
      const current = getTaskById(taskId);
      if (!current || current.ownerKey !== sessionKey) {
        return jsonResult({
          status: "not_found",
          error: `Task not found for session: ${taskId}`,
          taskId,
        });
      }
      const now = Date.now();
      const updated = updateTaskStateById({
        taskId,
        ...(status ? { status } : {}),
        ...(status === "running" && current.startedAt == null ? { startedAt: now } : {}),
        ...(status &&
        (status === "succeeded" ||
          status === "failed" ||
          status === "timed_out" ||
          status === "cancelled")
          ? { endedAt: now }
          : {}),
        lastEventAt: now,
        ...(error !== undefined ? { error } : {}),
        ...(progressSummary !== undefined ? { progressSummary } : {}),
        ...(terminalSummary !== undefined ? { terminalSummary } : {}),
        ...(terminalOutcome !== undefined ? { terminalOutcome } : {}),
      });
      if (!updated) {
        return jsonResult({
          status: "not_found",
          error: `Task not found: ${taskId}`,
          taskId,
        });
      }
      return textResult("Task updated.", {
        status: "updated" as const,
        sessionKey,
        task: updated,
      });
    },
  };
}
