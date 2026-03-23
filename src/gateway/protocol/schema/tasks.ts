/**
 * TypeBox schemas for Tasks RPC endpoints.
 */
import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ── Shared Models ────────────────────────────────────────────────────────

export const TaskSchema = Type.Object(
  {
    id: Type.String(),
    workspaceId: Type.String(),
    projectId: Type.Optional(Type.String()),
    goalId: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.String()),
    identifier: Type.String(),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("backlog"),
      Type.Literal("todo"),
      Type.Literal("in_progress"),
      Type.Literal("in_review"),
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("cancelled"),
    ]),
    priority: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
    assigneeAgentId: Type.Optional(Type.String()),
    billingCode: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    completedAt: Type.Optional(Type.Number()),
  },
  { $id: "Task" },
);

export const TaskCommentSchema = Type.Object(
  {
    id: Type.String(),
    taskId: Type.String(),
    authorId: Type.String(),
    authorType: Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("system")]),
    body: Type.String(),
    createdAt: Type.Number(),
  },
  { $id: "TaskComment" },
);

// ── Params ──────────────────────────────────────────────────────────────

export const TasksListParamsSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("backlog"),
      Type.Literal("todo"),
      Type.Literal("in_progress"),
      Type.Literal("in_review"),
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("cancelled"),
    ]),
  ),
  assigneeAgentId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
});

export const TasksGetParamsSchema = Type.Object({
  id: Type.String(),
});

export const TasksGetByIdentifierParamsSchema = Type.Object({
  workspaceId: Type.String(),
  identifier: Type.String(),
});

export const TasksCreateParamsSchema = Type.Object({
  workspaceId: Type.String(),
  title: NonEmptyString,
  description: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  priority: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
  ),
  assigneeAgentId: Type.Optional(Type.String()),
  billingCode: Type.Optional(Type.String()),
});

export const TasksUpdateParamsSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("backlog"),
      Type.Literal("todo"),
      Type.Literal("in_progress"),
      Type.Literal("in_review"),
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("cancelled"),
    ]),
  ),
  priority: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
    ]),
  ),
  assigneeAgentId: Type.Optional(Type.String()),
  billingCode: Type.Optional(Type.String()),
});

export const TasksListCommentsParamsSchema = Type.Object({
  taskId: Type.String(),
});

export const TasksAddCommentParamsSchema = Type.Object({
  taskId: Type.String(),
  body: NonEmptyString,
});

// ── Returns ──────────────────────────────────────────────────────────────

export const TasksListReturnSchema = Type.Object({ tasks: Type.Array(TaskSchema) });
export const TasksGetReturnSchema = TaskSchema;
export const TasksCreateReturnSchema = TaskSchema;
export const TasksUpdateReturnSchema = TaskSchema;

export const TasksListCommentsReturnSchema = Type.Object({
  comments: Type.Array(TaskCommentSchema),
});
export const TasksAddCommentReturnSchema = TaskCommentSchema;
