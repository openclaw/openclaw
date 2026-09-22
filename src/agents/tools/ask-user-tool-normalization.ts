import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  QuestionOptionSchema,
  QuestionRequestQuestionSchema,
  type QuestionRequestQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { questionShapeError } from "../../gateway/question-validation.js";
import { ToolInputError } from "./common.js";

export const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
export const QUESTION_RPC_GRACE_MS = 10_000;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;

export type NormalizedAskUserParams = {
  questions: QuestionRequestQuestion[];
  timeoutSeconds: number;
};

/** Validates and canonicalizes model-authored ask_user arguments. */
export function normalizeAskUserParams(value: unknown): NormalizedAskUserParams {
  if (!Value.Check(AskUserToolSchema, value)) {
    throw new ToolInputError("ask_user arguments do not match the model-facing question contract");
  }
  const params = value as Static<typeof AskUserToolSchema>;
  const questions: QuestionRequestQuestion[] = params.questions.map((question) => ({
    questionId: question.id.trim(),
    header: truncateUtf16Safe(question.header.trim(), 12),
    question: question.question.trim(),
    options: question.options.map((option) => ({
      label: option.label.trim(),
      ...(option.description?.trim() ? { description: option.description.trim() } : {}),
    })),
    ...(question.multiSelect === true ? { multiSelect: true } : {}),
    isOther: true,
  }));

  if (!questions.every((question) => Value.Check(QuestionRequestQuestionSchema, question))) {
    throw new ToolInputError("ask_user questions do not match the canonical question contract");
  }
  if (
    questions.some(
      ({ header, options }) => !header || options.some(({ label }) => label.length > 64),
    )
  ) {
    throw new ToolInputError("ask_user questions exceed the model-facing display contract");
  }
  const semanticError = questionShapeError(questions, {
    allowPlainSecretQuestions: false,
    validateUrls: true,
  });
  if (semanticError) {
    throw new ToolInputError(semanticError);
  }

  return { questions, timeoutSeconds: normalizeQuestionTimeoutSeconds(params.timeoutSeconds) };
}

/** Shared human-question wait contract, including credential entry and harness watchdogs. */
export function normalizeQuestionTimeoutSeconds(rawTimeoutSeconds: unknown): number {
  if (
    rawTimeoutSeconds !== undefined &&
    (typeof rawTimeoutSeconds !== "number" ||
      !Number.isFinite(rawTimeoutSeconds) ||
      !Number.isInteger(rawTimeoutSeconds))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  return Math.min(
    MAX_ASK_USER_TIMEOUT_SECONDS,
    Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, rawTimeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS),
  );
}

export function resolveQuestionTimeoutMs(rawTimeoutSeconds: unknown): number {
  return normalizeQuestionTimeoutSeconds(rawTimeoutSeconds) * 1_000 + QUESTION_RPC_GRACE_MS;
}

const AskUserQuestionSchema = Type.Object(
  {
    id: {
      ...QuestionRequestQuestionSchema.properties.questionId,
      description: "Unique snake_case answer key.",
    },
    header: Type.String({
      minLength: 1,
      description: "Short chip label; longer input is truncated to 12 characters.",
    }),
    question: {
      ...QuestionRequestQuestionSchema.properties.question,
      description: "Single-sentence question only. Put all selectable choices in options.",
    },
    options: Type.Array(QuestionOptionSchema, {
      minItems: 2,
      maxItems: 4,
      description:
        "Every selectable choice. Put the recommended choice first; do not repeat choices only in the question text.",
    }),
    multiSelect: Type.Optional({
      ...QuestionRequestQuestionSchema.properties.multiSelect,
      description: "True only when the user may choose several options at once.",
    }),
  },
  { additionalProperties: false },
);

export const AskUserToolSchema = Type.Object(
  {
    questions: Type.Array(AskUserQuestionSchema, { minItems: 1, maxItems: 3 }),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description:
          "Maximum human wait in seconds; default 900, clamped 30-3600. Earlier run cancellation or overall run timeout still applies.",
      }),
    ),
  },
  { additionalProperties: false },
);
