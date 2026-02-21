import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ToolInterruptEmitParamsSchema = Type.Object(
  {
    approvalRequestId: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    toolCallId: NonEmptyString,
    toolName: Type.Optional(NonEmptyString),
    normalizedArgsHash: Type.Optional(
      Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    ),
    interrupt: Type.Record(Type.String(), Type.Unknown()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolInterruptResumeParamsSchema = Type.Object(
  {
    approvalRequestId: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    toolCallId: NonEmptyString,
    toolName: Type.Optional(NonEmptyString),
    normalizedArgsHash: Type.Optional(
      Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    ),
    resumeToken: NonEmptyString,
    decisionReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    policyRuleId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    decisionAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    decisionMeta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ToolInterruptListParamsSchema = Type.Object(
  {
    state: Type.Optional(Type.Union([Type.Literal("pending")])),
  },
  { additionalProperties: false },
);
