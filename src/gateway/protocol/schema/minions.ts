import { Type } from "@sinclair/typebox";

const MinionJobStatusSchema = Type.Union([
  Type.Literal("waiting"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("delayed"),
  Type.Literal("dead"),
  Type.Literal("cancelled"),
  Type.Literal("waiting-children"),
  Type.Literal("paused"),
  Type.Literal("attached"),
]);

export const MinionJobSubmitParamsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    queue: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Integer()),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
    delay: Type.Optional(Type.Integer({ minimum: 0 })),
    parentJobId: Type.Optional(Type.Integer()),
    maxChildren: Type.Optional(Type.Integer({ minimum: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    idempotencyKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MinionJobResponseSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  queue: Type.String(),
  status: MinionJobStatusSchema,
  priority: Type.Integer(),
  depth: Type.Integer(),
  parentJobId: Type.Union([Type.Integer(), Type.Null()]),
  tokensInput: Type.Integer(),
  tokensOutput: Type.Integer(),
  tokensCacheRead: Type.Integer(),
  createdAt: Type.Integer(),
  startedAt: Type.Union([Type.Integer(), Type.Null()]),
  finishedAt: Type.Union([Type.Integer(), Type.Null()]),
});

export const MinionJobListParamsSchema = Type.Object(
  {
    status: Type.Optional(MinionJobStatusSchema),
    queue: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const MinionJobCancelParamsSchema = Type.Object(
  {
    id: Type.Integer(),
  },
  { additionalProperties: false },
);

export const MinionJobStatsResponseSchema = Type.Object({
  byStatus: Type.Record(Type.String(), Type.Integer()),
  queueHealth: Type.Object({
    waiting: Type.Integer(),
    active: Type.Integer(),
    stalled: Type.Integer(),
  }),
});

export const MinionInboxSendParamsSchema = Type.Object(
  {
    jobId: Type.Integer(),
    payload: Type.Unknown(),
    sender: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
