import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    pluginId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    title: NonEmptyString,
    description: NonEmptyString,
    severity: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolCallId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
