import { Type, type Static } from "@sinclair/typebox";

export const ReplayRunModeSchema = Type.Union([Type.Literal("recorded")]);

export const ReplayErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReplayRunsCreateRequestSchema = Type.Object(
  {
    trajectoryPath: Type.String({ minLength: 1 }),
    mode: Type.Optional(ReplayRunModeSchema),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
    toolAllowlist: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const ReplayRunsCreateResponseSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("created"), Type.Literal("running")]),
    mode: ReplayRunModeSchema,
  },
  { additionalProperties: false },
);

export const ReplayRunsStepRequestSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReplayStepToolCallSchema = Type.Object(
  {
    toolCallId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    ok: Type.Optional(Type.Boolean()),
    resultSummary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReplayRunsStepResponseSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("running"), Type.Literal("completed")]),
    stepIdx: Type.Integer({ minimum: 0 }),
    done: Type.Boolean(),
    assistantText: Type.Optional(Type.String()),
    replayedToolCalls: Type.Array(ReplayStepToolCallSchema),
  },
  { additionalProperties: false },
);

export const ReplayRunsGetStateRequestSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReplayRunsGetStateResponseSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("created"),
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("closed"),
    ]),
    mode: ReplayRunModeSchema,
    stepIdx: Type.Integer({ minimum: 0 }),
    totalSteps: Type.Integer({ minimum: 0 }),
    toolCallCount: Type.Integer({ minimum: 0 }),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ReplayRunsCloseRequestSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReplayRunsCloseResponseSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    status: Type.Literal("closed"),
  },
  { additionalProperties: false },
);

export type ReplayRunsCreateRequest = Static<typeof ReplayRunsCreateRequestSchema>;
export type ReplayRunsCreateResponse = Static<typeof ReplayRunsCreateResponseSchema>;
export type ReplayRunsStepRequest = Static<typeof ReplayRunsStepRequestSchema>;
export type ReplayRunsStepResponse = Static<typeof ReplayRunsStepResponseSchema>;
export type ReplayRunsGetStateRequest = Static<typeof ReplayRunsGetStateRequestSchema>;
export type ReplayRunsGetStateResponse = Static<typeof ReplayRunsGetStateResponseSchema>;
export type ReplayRunsCloseRequest = Static<typeof ReplayRunsCloseRequestSchema>;
export type ReplayRunsCloseResponse = Static<typeof ReplayRunsCloseResponseSchema>;
