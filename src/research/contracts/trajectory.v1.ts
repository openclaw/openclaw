import { Type, type Static } from "@sinclair/typebox";

export const TrajectoryMessageSchema = Type.Object(
  {
    idx: Type.Integer({ minimum: 0 }),
    jsonlLine: Type.Integer({ minimum: 1 }),
    role: Type.String({ minLength: 1 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const TrajectoryToolCallSchema = Type.Object(
  {
    stepIdx: Type.Integer({ minimum: 0 }),
    toolCallId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    startTs: Type.Integer({ minimum: 0 }),
    endTs: Type.Optional(Type.Integer({ minimum: 0 })),
    ok: Type.Optional(Type.Boolean()),
    argsSummary: Type.Optional(Type.String()),
    resultSummary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TrajectorySessionSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionKey: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const TrajectorySummarySchema = Type.Object(
  {
    messageCount: Type.Integer({ minimum: 0 }),
    eventCount: Type.Integer({ minimum: 0 }),
    toolCallCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TrajectoryEventSchema = Type.Object(
  {
    v: Type.Literal(1),
    ts: Type.Integer({ minimum: 0 }),
    runId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionKey: Type.Optional(Type.String({ minLength: 1 })),
    agentId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    payload: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

export const TrajectoryV1Schema = Type.Object(
  {
    v: Type.Literal(1),
    session: TrajectorySessionSchema,
    messages: Type.Array(TrajectoryMessageSchema),
    events: Type.Array(TrajectoryEventSchema),
    toolCalls: Type.Array(TrajectoryToolCallSchema),
    summary: TrajectorySummarySchema,
  },
  { additionalProperties: false },
);

export type TrajectoryV1 = Static<typeof TrajectoryV1Schema>;
export type TrajectoryMessage = Static<typeof TrajectoryMessageSchema>;
export type TrajectoryToolCall = Static<typeof TrajectoryToolCallSchema>;
