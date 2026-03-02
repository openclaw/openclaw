import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// ─── TeamRuns ────────────────────────────────────────────────────────

export const TeamRunsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    leader: NonEmptyString,
    leaderSession: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TeamRunsListParamsSchema = Type.Object(
  {
    leader: Type.Optional(NonEmptyString),
    state: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("failed")]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const TeamRunsGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TeamRunsCompleteParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    state: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  },
  { additionalProperties: false },
);

export const TeamRunsAddMemberParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    agentId: NonEmptyString,
    sessionKey: NonEmptyString,
    role: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const TeamRunsUpdateMemberParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    agentId: NonEmptyString,
    state: Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("done")]),
  },
  { additionalProperties: false },
);

// ─── TeamTasks ───────────────────────────────────────────────────────

export const TeamTasksCreateParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    subject: NonEmptyString,
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TeamTasksListParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TeamTasksUpdateParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    taskId: NonEmptyString,
    owner: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    status: Type.Optional(
      Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    ),
    subject: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    blockedBy: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const TeamTasksDeleteParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    taskId: NonEmptyString,
  },
  { additionalProperties: false },
);

// ─── TeamMessages ────────────────────────────────────────────────────

export const TeamMessagesSendParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    content: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TeamMessagesMarkReadParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    agentId: NonEmptyString,
    messageIds: Type.Array(NonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const TeamMessagesListParamsSchema = Type.Object(
  {
    teamRunId: NonEmptyString,
    from: Type.Optional(NonEmptyString),
    to: Type.Optional(NonEmptyString),
    since: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
