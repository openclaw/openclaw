import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const PlanInputOptionSchema = Type.Object(
  {
    label: NonEmptyString,
    description: Type.String(),
  },
  { additionalProperties: false },
);

const PlanInputQuestionSchema = Type.Object(
  {
    header: NonEmptyString,
    id: NonEmptyString,
    question: NonEmptyString,
    options: Type.Array(PlanInputOptionSchema, { minItems: 2, maxItems: 4 }),
  },
  { additionalProperties: false },
);

const PlanInputAnswerSchema = Type.Object(
  {
    answer: Type.String(),
    source: Type.Union([Type.Literal("option"), Type.Literal("other")]),
    optionIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PlanInputRequestParamsSchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    questions: Type.Array(PlanInputQuestionSchema, { minItems: 1, maxItems: 3 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const PlanInputResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    status: Type.Union([
      Type.Literal("answered"),
      Type.Literal("cancelled"),
      Type.Literal("expired"),
    ]),
    answers: Type.Optional(Type.Record(Type.String(), PlanInputAnswerSchema)),
  },
  { additionalProperties: false },
);

export const PlanInputPromptSchema = Type.Object(
  {
    id: NonEmptyString,
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    questions: Type.Array(PlanInputQuestionSchema, { minItems: 1, maxItems: 3 }),
    createdAtMs: Type.Integer({ minimum: 0 }),
    expiresAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const PlanInputResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("answered"),
      Type.Literal("cancelled"),
      Type.Literal("expired"),
    ]),
    answers: Type.Optional(Type.Record(Type.String(), PlanInputAnswerSchema)),
  },
  { additionalProperties: false },
);
