/** Built-in blocking user-question tool. */
import { Type } from "typebox";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type { StructuredInputCapability } from "../harness/structured-input-execution.js";
import { compileStructuredInputQuestions } from "../harness/structured-input.js";
import { ASK_USER_TOOL_DISPLAY_SUMMARY, describeAskUserTool } from "../tool-description-presets.js";
import {
  type NormalizedAskUserParams,
  normalizeAskUserParams,
} from "./ask-user-tool-normalization.js";
import { type AnyAgentTool, ToolInputError, textResult } from "./common.js";

const AskUserToolSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            pattern: "^[a-z][a-z0-9_]*$",
            description: "Unique snake_case answer key.",
          }),
          header: Type.String({
            minLength: 1,
            description: "Short chip label; longer input is truncated to 12 characters.",
          }),
          question: Type.String({
            minLength: 1,
            description: "Single-sentence question for the user.",
          }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutSeconds: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

function answeredResult(
  questions: readonly QuestionRequestQuestion[],
  answers: Record<string, string[]>,
) {
  const payload = { status: "answered" as const, answers: { answers } };
  const lines = questions.map((question) => {
    const values = answers[question.questionId] ?? [];
    return `${question.header}: ${values.length > 0 ? values.join(", ") : "(no answer)"}`;
  });
  return textResult(`${lines.join("\n")}\n\n${JSON.stringify(payload, null, 2)}`, payload);
}

function noAnswerResult() {
  const payload = { status: "no_answer" as const };
  return textResult(
    `The question was cancelled; proceed with best judgment.\n\n${JSON.stringify(payload, null, 2)}`,
    payload,
  );
}

function compileAskUserInput(normalized: NormalizedAskUserParams) {
  return compileStructuredInputQuestions({
    intro: "Question for you:",
    questions: normalized.questions.map(({ questionId, ...question }) => ({
      ...question,
      id: questionId,
      isSecret: false,
    })),
  });
}

/** Creates the main-session-only blocking ask_user tool. */
export function createAskUserTool(params: {
  structuredInputCapability?: StructuredInputCapability;
}): AnyAgentTool {
  return {
    label: "Ask User",
    name: "ask_user",
    displaySummary: ASK_USER_TOOL_DISPLAY_SUMMARY,
    description: describeAskUserTool(),
    parameters: AskUserToolSchema,
    execute: async (toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const normalized = normalizeAskUserParams(args);
      const capability = params.structuredInputCapability;
      if (!capability) {
        throw new ToolInputError(
          "ask_user is unavailable because this run has no structured input capability",
        );
      }
      try {
        const result = await capability.request({
          toolCallId,
          input: compileAskUserInput(normalized),
          timeoutMs: normalized.timeoutSeconds * 1_000,
          signal,
        });
        return result.status === "answered"
          ? answeredResult(normalized.questions, result.answers)
          : noAnswerResult();
      } catch (error) {
        throw new ToolInputError(
          error instanceof Error ? error.message : "ask_user could not collect operator input",
        );
      }
    },
  };
}
