import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  QuestionOptionSchema,
  QuestionRequestQuestionSchema,
  type QuestionRequestQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { questionShapeError } from "../../gateway/question-validation.js";
import { normalizeQuestionTimeoutSeconds } from "../question-timeout.js";
import { ToolInputError } from "../tool-input-error.js";

export const REQUIRED_ACTION_READY = "Ready to recheck";
const REQUIRED_ACTION_STOP = "Stop this task";

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
            description:
              "Observed external blocker, not an assumed policy denial or inactive Goal status.",
          }),
          instructions: Type.String({
            minLength: 1,
            maxLength: 2000,
            description:
              "External human-only step that can finish while this run waits. Never Goal Resume, an idle-session control, or approval of already authorized work.",
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
