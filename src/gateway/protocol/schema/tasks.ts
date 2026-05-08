import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const TaskRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("cancelled"),
  Type.Literal("lost"),
]);

export const TaskRunRuntimeSchema = Type.Union([
  Type.Literal("subagent"),
  Type.Literal("acp"),
  Type.Literal("cli"),
  Type.Literal("cron"),
]);

export const TaskRunDeliveryStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("delivered"),
  Type.Literal("session_queued"),
  Type.Literal("failed"),
  Type.Literal("parent_missing"),
  Type.Literal("not_applicable"),
]);

export const TaskRunNotifyPolicySchema = Type.Union([
  Type.Literal("done_only"),
  Type.Literal("state_changes"),
  Type.Literal("silent"),
]);

export const TaskFlowSyncModeSchema = Type.Union([
  Type.Literal("task_mirrored"),
  Type.Literal("managed"),
]);

export const TaskFlowStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("lost"),
]);

export const TaskRunAggregateSummarySchema = Type.Object(
  {
    total: Type.Number(),
    active: Type.Number(),
    terminal: Type.Number(),
    failures: Type.Number(),
    byStatus: Type.Record(Type.String(), Type.Number()),
    byRuntime: Type.Record(Type.String(), Type.Number()),
  },
  { additionalProperties: false },
);

export const TaskRunViewSchema = Type.Object(
  {
    id: NonEmptyString,
    runtime: TaskRunRuntimeSchema,
    sourceId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
    ownerKey: NonEmptyString,
    scope: Type.Union([Type.Literal("session"), Type.Literal("system")]),
    childSessionKey: Type.Optional(NonEmptyString),
    flowId: Type.Optional(NonEmptyString),
    parentTaskId: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    label: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    status: TaskRunStatusSchema,
    deliveryStatus: TaskRunDeliveryStatusSchema,
    notifyPolicy: TaskRunNotifyPolicySchema,
    createdAt: Type.Number(),
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
    lastEventAt: Type.Optional(Type.Number()),
    cleanupAfter: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    terminalOutcome: Type.Optional(
      Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]),
    ),
  },
  { additionalProperties: false },
);

export const TaskFlowViewSchema = Type.Object(
  {
    id: NonEmptyString,
    syncMode: TaskFlowSyncModeSchema,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(Type.Unknown()),
    controllerId: Type.Optional(NonEmptyString),
    revision: Type.Number(),
    status: TaskFlowStatusSchema,
    notifyPolicy: TaskRunNotifyPolicySchema,
    goal: NonEmptyString,
    currentStep: Type.Optional(NonEmptyString),
    cancelRequestedAt: Type.Optional(Type.Number()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    endedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const TaskFlowDetailSchema = Type.Object(
  {
    id: NonEmptyString,
    syncMode: TaskFlowSyncModeSchema,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(Type.Unknown()),
    controllerId: Type.Optional(NonEmptyString),
    revision: Type.Number(),
    status: TaskFlowStatusSchema,
    notifyPolicy: TaskRunNotifyPolicySchema,
    goal: NonEmptyString,
    currentStep: Type.Optional(NonEmptyString),
    cancelRequestedAt: Type.Optional(Type.Number()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    endedAt: Type.Optional(Type.Number()),
    state: Type.Optional(Type.Unknown()),
    wait: Type.Optional(Type.Unknown()),
    blocked: Type.Optional(
      Type.Object(
        {
          taskId: Type.Optional(NonEmptyString),
          summary: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    tasks: Type.Array(TaskRunViewSchema),
    taskSummary: TaskRunAggregateSummarySchema,
  },
  { additionalProperties: false },
);

export const TasksListParamsSchema = Type.Object(
  {
    sessionKey: Type.Optional(NonEmptyString),
    ownerKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    status: Type.Optional(TaskRunStatusSchema),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    tasks: Type.Array(TaskRunViewSchema),
  },
  { additionalProperties: false },
);

export const TasksGetParamsSchema = Type.Object(
  { taskId: NonEmptyString },
  { additionalProperties: false },
);

export const TasksGetResultSchema = Type.Object(
  { task: TaskRunViewSchema },
  { additionalProperties: false },
);

export const TasksCancelParamsSchema = Type.Object(
  { taskId: NonEmptyString },
  { additionalProperties: false },
);

export const TasksCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    task: Type.Optional(TaskRunViewSchema),
  },
  { additionalProperties: false },
);

export const TaskFlowsListParamsSchema = Type.Object(
  {
    ownerKey: Type.Optional(NonEmptyString),
    status: Type.Optional(TaskFlowStatusSchema),
    active: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TaskFlowsListResultSchema = Type.Object(
  {
    flows: Type.Array(TaskFlowDetailSchema),
  },
  { additionalProperties: false },
);

export const TaskFlowsGetParamsSchema = Type.Object(
  { flowId: NonEmptyString },
  { additionalProperties: false },
);

export const TaskFlowsGetResultSchema = Type.Object(
  { flow: TaskFlowDetailSchema },
  { additionalProperties: false },
);

export const TaskFlowsCancelParamsSchema = Type.Object(
  { flowId: NonEmptyString },
  { additionalProperties: false },
);

export const TaskFlowsCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    flow: Type.Optional(TaskFlowDetailSchema),
  },
  { additionalProperties: false },
);
