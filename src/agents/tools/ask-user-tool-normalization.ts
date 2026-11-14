import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  QuestionOptionSchema,
  QuestionRequestQuestionSchema,
  type QuestionRequestQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { questionShapeError } from "../../gateway/question-validation.js";
import { ToolInputError } from "./common.js";

export const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
export const REQUIRED_ACTION_READY = "Ready to recheck";
const REQUIRED_ACTION_STOP = "Stop this task";
export const QUESTION_RPC_GRACE_MS = 10_000;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;

export type NormalizedAskUserParams = ReturnType<typeof normalizeAskUserParams>;

/** Validates and canonicalizes model-authored ask_user arguments. */
export function normalizeAskUserParams(value: unknown) {
  if (!Value.Check(AskUserToolSchema, value)) {
    throw new ToolInputError("ask_user arguments do not match the model-facing question contract");
  }
  const questions: QuestionRequestQuestion[] = [];
  const action = value.requiredAction;
  if (action) {
    if (value.questions) {
      throw new ToolInputError("ask_user accepts questions or requiredAction, not both");
    }
    if (!action.reason.trim() || !action.instructions.trim()) {
      throw new ToolInputError("requiredAction needs a specific blocker and supported manual step");
    }
    questions.push({
      questionId: "required_action",
      header: "Manual step",
      question: [
        action.reason.trim(),
        action.instructions.trim(),
        ...(action.url ? [action.url] : []),
      ].join("\n\n"),
      ...(action.url ? { url: action.url } : {}),
      options: [{ label: REQUIRED_ACTION_READY }, { label: REQUIRED_ACTION_STOP }],
      isOther: false,
    });
  } else {
    if (!value.questions) {
      throw new ToolInputError("ask_user requires questions or requiredAction");
    }
    questions.push(
      ...value.questions.map((question) => ({
        questionId: question.id.trim(),
        header: truncateUtf16Safe(question.header.trim(), 12),
        question: question.question.trim(),
        options: question.options.map((option) => ({
          label: option.label.trim(),
          ...(option.description?.trim() ? { description: option.description.trim() } : {}),
        })),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
        isOther: true,
      })),
    );
  }

  if (!questions.every((question) => Value.Check(QuestionRequestQuestionSchema, question))) {
    throw new ToolInputError("ask_user questions do not match the required question format");
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

  return {
    questions,
    timeoutSeconds: normalizeQuestionTimeoutSeconds(value.timeoutSeconds),
    ...(action ? { requiredAction: true as const } : {}),
  };
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
    questions: Type.Optional(Type.Array(AskUserQuestionSchema, { minItems: 1, maxItems: 3 })),
    requiredAction: Type.Optional(
      Type.Object(
        {
          reason: Type.String({
            minLength: 1,
            maxLength: 500,
            description: "Specific observed blocker, not an assumed policy denial.",
          }),
          instructions: Type.String({
            minLength: 1,
            maxLength: 2000,
            description:
              "Supported human-only step in the already selected surface. Not a request to approve existing task authority.",
          }),
          url: Type.Optional({
            ...QuestionRequestQuestionSchema.properties.url,
            description:
              "Optional verified HTTP(S) destination. Opening it is not completion or authorization.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description:
          "Maximum human wait in seconds; default 900, clamped 30-3600. Earlier run cancellation or overall run timeout still applies.",
      }),
    ),
  },
  { additionalProperties: false },
);
