import { Static, Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const NonNegativeInteger = Type.Integer({ minimum: 0 });

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

const TaskFlowStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
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

const TaskTerminalOutcomeSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("blocked")]);

const TaskScopeKindSchema = Type.Union([Type.Literal("session"), Type.Literal("system")]);

const DeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(NonEmptyString),
    to: Type.Optional(NonEmptyString),
    accountId: Type.Optional(NonEmptyString),
    threadId: Type.Optional(Type.Union([NonEmptyString, Type.Number()])),
  },
  { additionalProperties: false },
);

const TaskStatusCountsSchema = Type.Object(
  {
    queued: NonNegativeInteger,
    running: NonNegativeInteger,
    succeeded: NonNegativeInteger,
    failed: NonNegativeInteger,
    timed_out: NonNegativeInteger,
    cancelled: NonNegativeInteger,
    lost: NonNegativeInteger,
  },
  { additionalProperties: false },
);

const TaskRuntimeCountsSchema = Type.Object(
  {
    subagent: NonNegativeInteger,
    acp: NonNegativeInteger,
    cli: NonNegativeInteger,
    cron: NonNegativeInteger,
  },
  { additionalProperties: false },
);

export const TaskRunAggregateSummarySchema = Type.Object(
  {
    total: NonNegativeInteger,
    active: NonNegativeInteger,
    terminal: NonNegativeInteger,
    failures: NonNegativeInteger,
    byStatus: TaskStatusCountsSchema,
    byRuntime: TaskRuntimeCountsSchema,
  },
  { additionalProperties: false },
);

export const TaskRunViewSchema = Type.Object(
  {
    id: NonEmptyString,
    runtime: TaskRuntimeSchema,
    sourceId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
    ownerKey: NonEmptyString,
    scope: TaskScopeKindSchema,
    childSessionKey: Type.Optional(NonEmptyString),
    flowId: Type.Optional(NonEmptyString),
    parentTaskId: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    label: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    status: TaskStatusSchema,
    deliveryStatus: TaskDeliveryStatusSchema,
    notifyPolicy: TaskNotifyPolicySchema,
    createdAt: Type.Number(),
    startedAt: Type.Optional(Type.Number()),
    endedAt: Type.Optional(Type.Number()),
    lastEventAt: Type.Optional(Type.Number()),
    cleanupAfter: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
    progressSummary: Type.Optional(Type.String()),
    terminalSummary: Type.Optional(Type.String()),
    terminalOutcome: Type.Optional(TaskTerminalOutcomeSchema),
  },
  { additionalProperties: false },
);

export const TaskRunDetailSchema = TaskRunViewSchema;

export const TaskFlowViewSchema = Type.Object(
  {
    id: NonEmptyString,
    ownerKey: NonEmptyString,
    requesterOrigin: Type.Optional(DeliveryContextSchema),
    status: TaskFlowStatusSchema,
    notifyPolicy: TaskNotifyPolicySchema,
    goal: NonEmptyString,
    currentStep: Type.Optional(Type.String()),
    cancelRequestedAt: Type.Optional(Type.Number()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    endedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const TaskFlowDetailSchema = Type.Composite([
  TaskFlowViewSchema,
  Type.Object(
    {
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
  ),
]);

export const TasksListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    query: Type.Optional(Type.String()),
    statuses: Type.Optional(Type.Array(TaskStatusSchema, { minItems: 1 })),
    runtime: Type.Optional(TaskRuntimeSchema),
    flowId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    tasks: Type.Array(TaskRunViewSchema),
    summary: TaskRunAggregateSummarySchema,
  },
  { additionalProperties: false },
);

export const TasksShowParamsSchema = Type.Union([
  Type.Object({ id: NonEmptyString }, { additionalProperties: false }),
  Type.Object({ token: NonEmptyString }, { additionalProperties: false }),
]);

export const TasksShowResultSchema = Type.Object(
  {
    task: Type.Union([TaskRunDetailSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const TasksFlowsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    query: Type.Optional(Type.String()),
    statuses: Type.Optional(Type.Array(TaskFlowStatusSchema, { minItems: 1 })),
    ownerKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const TasksFlowsListResultSchema = Type.Object(
  {
    flows: Type.Array(TaskFlowDetailSchema),
  },
  { additionalProperties: false },
);

export type TaskRunAggregateSummary = Static<typeof TaskRunAggregateSummarySchema>;
export type TaskRunView = Static<typeof TaskRunViewSchema>;
export type TaskRunDetail = Static<typeof TaskRunDetailSchema>;
export type TaskFlowView = Static<typeof TaskFlowViewSchema>;
export type TaskFlowDetail = Static<typeof TaskFlowDetailSchema>;
export type TasksListParams = Static<typeof TasksListParamsSchema>;
export type TasksListResult = Static<typeof TasksListResultSchema>;
export type TasksShowParams = Static<typeof TasksShowParamsSchema>;
export type TasksShowResult = Static<typeof TasksShowResultSchema>;
export type TasksFlowsListParams = Static<typeof TasksFlowsListParamsSchema>;
export type TasksFlowsListResult = Static<typeof TasksFlowsListResultSchema>;
