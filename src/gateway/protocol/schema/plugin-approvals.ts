import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    pluginId: Type.Optional(NonEmptyString),
    title: NonEmptyString,
    description: NonEmptyString,
    severity: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    turnSourceChannel: Type.Optional(Type.String()),
    turnSourceTo: Type.Optional(Type.String()),
    turnSourceAccountId: Type.Optional(Type.String()),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
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
