import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const TaskRuntimeSchema = Type.Union([
  Type.Literal("subagent"),
  Type.Literal("acp"),
  Type.Literal("cli"),
  Type.Literal("cron"),
]);

const TaskStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("lost"),
]);

const TaskDeliveryStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("delivered"),
  Type.Literal("session_queued"),
  Type.Literal("failed"),
  Type.Literal("parent_missing"),
  Type.Literal("not_applicable"),
]);

const TaskNotifyPolicySchema = Type.Union([
  Type.Literal("done_only"),
  Type.Literal("state_changes"),
  Type.Literal("silent"),
]);

const TaskScopeKindSchema = Type.Union([Type.Literal("session"), Type.Literal("system")]);
const TaskTerminalOutcomeSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]);

export const TaskRecordSchema = Type.Object(
  {
    taskId: NonEmptyString,
    runtime: TaskRuntimeSchema,
    taskKind: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    requesterSessionKey: Type.String(),
    ownerKey: Type.String(),
    scopeKind: TaskScopeKindSchema,
    childSessionKey: Type.Optional(Type.String()),
    parentFlowId: Type.Optional(Type.String()),
    parentTaskId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    task: Type.String(),
    status: TaskStatusSchema,
    deliveryStatus: TaskDeliveryStatusSchema,
    notifyPolicy: TaskNotifyPolicySchema,
    createdAt: Type.Integer({ minimum: 0 }),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastEventAt: Type.Optional(Type.Integer({ minimum: 0 })),
    cleanupAfter: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    terminalOutcome: Type.Optional(TaskTerminalOutcomeSchema),
  },
  { additionalProperties: false },
);

export const TasksListParamsSchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([TaskStatusSchema, Type.Array(TaskStatusSchema, { minItems: 1 })]),
    ),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    count: Type.Integer({ minimum: 0 }),
    tasks: Type.Array(TaskRecordSchema),
  },
  { additionalProperties: false },
);

export const TasksGetParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksGetResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    task: Type.Optional(TaskRecordSchema),
  },
  { additionalProperties: false },
);

export const TasksCancelParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    task: Type.Optional(TaskRecordSchema),
  },
  { additionalProperties: false },
);
