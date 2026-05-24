import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

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

export const TaskLedgerStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timed_out"),
]);

const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

export const TaskSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Optional(Type.String()),
    runtime: Type.Optional(Type.String()),
    status: TaskLedgerStatusSchema,
    title: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    childSessionKey: Type.Optional(Type.String()),
    ownerKey: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    flowId: Type.Optional(Type.String()),
    parentTaskId: Type.Optional(Type.String()),
    sourceId: Type.Optional(Type.String()),
    createdAt: Type.Optional(TimestampSchema),
    updatedAt: Type.Optional(TimestampSchema),
    startedAt: Type.Optional(TimestampSchema),
    endedAt: Type.Optional(TimestampSchema),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    tasks: Type.Array(TaskSummarySchema),
    nextCursor: Type.Optional(Type.String()),
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
    task: TaskSummarySchema,
  },
  { additionalProperties: false },
);

export const TasksCancelParamsSchema = Type.Object(
  {
    taskId: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TasksCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    task: Type.Optional(TaskSummarySchema),
  },
  { additionalProperties: false },
);

export const TaskRunAggregateSummarySchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    active: Type.Integer({ minimum: 0 }),
    terminal: Type.Integer({ minimum: 0 }),
    failures: Type.Integer({ minimum: 0 }),
    byStatus: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    byRuntime: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const TaskFlowSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(Type.Unknown()),
    status: TaskFlowStatusSchema,
    notifyPolicy: Type.String(),
    goal: Type.String(),
    currentStep: Type.Optional(Type.String()),
    cancelRequestedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const TaskFlowDetailSchema = Type.Object(
  {
    id: NonEmptyString,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(Type.Unknown()),
    status: TaskFlowStatusSchema,
    notifyPolicy: Type.String(),
    goal: Type.String(),
    currentStep: Type.Optional(Type.String()),
    cancelRequestedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    state: Type.Optional(Type.Unknown()),
    wait: Type.Optional(Type.Unknown()),
    blocked: Type.Optional(
      Type.Object(
        {
          taskId: Type.Optional(Type.String()),
          summary: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    tasks: Type.Array(Type.Unknown()),
    taskSummary: TaskRunAggregateSummarySchema,
  },
  { additionalProperties: false },
);

export const TaskFlowsListParamsSchema = Type.Object(
  {
    status: Type.Optional(Type.Union([TaskFlowStatusSchema, Type.Array(TaskFlowStatusSchema)])),
    sessionKey: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsListResultSchema = Type.Object(
  {
    flows: Type.Array(TaskFlowSummarySchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskFlowsGetParamsSchema = Type.Object(
  {
    flowId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TaskFlowsGetResultSchema = Type.Object(
  {
    flow: TaskFlowDetailSchema,
  },
  { additionalProperties: false },
);

export const TaskFlowsCancelParamsSchema = Type.Object(
  {
    flowId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TaskFlowsCancelResultSchema = Type.Object(
  {
    found: Type.Boolean(),
    cancelled: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    flow: Type.Optional(TaskFlowDetailSchema),
    tasks: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);
