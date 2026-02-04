import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const AgentShieldApprovalRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    toolName: NonEmptyString,
    paramsJSON: NonEmptyString,
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const AgentShieldApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentShieldApprovalListParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);
