/**
 * ask_user_question built-in tool.
 *
 * Lets any agent ask the user a structured question — options + a Recommended
 * first choice + free-text "Other" — that renders as a card in Control UI, an
 * inline keyboard on Telegram, Block Kit on Slack, or numbered text elsewhere,
 * and is answerable from any surface. The tool parks on a promise held by the
 * global QuestionManager until any surface resolves it (or it expires).
 */
import { Type } from "typebox";
import { getGlobalQuestionManager } from "../../gateway/question-manager.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AgentHarnessUserInputQuestion } from "../harness/user-input-bridge.js";
import { type AnyAgentTool, ToolInputError, jsonResult } from "./common.js";

const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LEN = 12;

const AskUserQuestionOptionSchema = Type.Object(
  {
    label: Type.String({ description: "Short option label the user taps or types." }),
    description: Type.Optional(
      Type.String({ description: "Optional one-line clarification for the option." }),
    ),
  },
  { additionalProperties: false },
);

const AskUserQuestionItemSchema = Type.Object(
  {
    header: Type.String({
      description: "Very short topic label (<=12 chars), e.g. 'Deploy' or 'Branch'.",
    }),
    question: Type.String({ description: "The question to ask the user." }),
    options: Type.Optional(
      Type.Array(AskUserQuestionOptionSchema, {
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description:
          "2-4 options. Put the recommended choice FIRST and suffix its label with ' (Recommended)'. A free-text 'Other' is always added for you.",
      }),
    ),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Must be false or omitted; multi-select is not supported yet." }),
    ),
  },
  { additionalProperties: false },
);

const AskUserQuestionToolSchema = Type.Object(
  {
    questions: Type.Array(AskUserQuestionItemSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: "1-3 questions. Strongly prefer a SINGLE question unless they are independent.",
    }),
  },
  { additionalProperties: false },
);

const ASK_USER_QUESTION_DESCRIPTION = [
  "Ask the user a structured question and wait for their answer.",
  "Use this when you are blocked on a decision only the user can make (which option, which branch, confirm before an irreversible step).",
  "Strongly prefer ONE question with 2-4 options. Put the recommended option FIRST and suffix its label with ' (Recommended)'.",
  "A free-text 'Other' choice is always added automatically — do not add your own.",
  "Do not use for information you can obtain yourself. The tool blocks until the user replies from any surface (Control UI, Telegram, Slack, or chat).",
].join(" ");

export type AskUserQuestionToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  /** Originating channel so the pending question can route back to the asking surface. */
  agentChannel?: GatewayMessageChannel;
  agentTo?: string;
  agentAccountId?: string;
  agentThreadId?: string | number;
};

type RawOption = { label: string; description?: string };
type RawQuestion = {
  header: string;
  question: string;
  options?: RawOption[];
  multiSelect?: boolean;
};

function readRawOption(value: unknown, path: string): RawOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "label" && key !== "description") {
      throw new ToolInputError(`${path} has unknown field '${key}'`);
    }
  }
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label) {
    throw new ToolInputError(`${path}.label required`);
  }
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : undefined;
  return { label, ...(description ? { description } : {}) };
}

function readRawQuestion(value: unknown, index: number): RawQuestion {
  const path = `questions[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "header" && key !== "question" && key !== "options" && key !== "multiSelect") {
      throw new ToolInputError(`${path} has unknown field '${key}'`);
    }
  }
  const header = typeof record.header === "string" ? record.header.trim() : "";
  if (!header) {
    throw new ToolInputError(`${path}.header required`);
  }
  if (header.length > MAX_HEADER_LEN) {
    throw new ToolInputError(`${path}.header must be <= ${MAX_HEADER_LEN} characters`);
  }
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) {
    throw new ToolInputError(`${path}.question required`);
  }
  if (record.multiSelect !== undefined && record.multiSelect !== false) {
    throw new ToolInputError(`${path}.multiSelect must be false; multi-select is not supported`);
  }
  let options: RawOption[] | undefined;
  if (record.options !== undefined) {
    if (!Array.isArray(record.options)) {
      throw new ToolInputError(`${path}.options must be an array`);
    }
    if (record.options.length < MIN_OPTIONS || record.options.length > MAX_OPTIONS) {
      throw new ToolInputError(
        `${path}.options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`,
      );
    }
    options = record.options.map((option, optionIndex) =>
      readRawOption(option, `${path}.options[${optionIndex}]`),
    );
  }
  return { header, question, ...(options ? { options } : {}) };
}

function normalizeQuestions(rawQuestions: RawQuestion[]): AgentHarnessUserInputQuestion[] {
  return rawQuestions.map((raw, index) => ({
    id: `q${index + 1}`,
    header: raw.header,
    question: raw.question,
    // Always offer a free-form answer, mirroring codex normalize_request_user_input_args.
    isOther: true,
    options: raw.options?.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  }));
}

/** Creates the ask_user_question tool bound to the current run's session/turn source. */
export function createAskUserQuestionTool(options: AskUserQuestionToolOptions = {}): AnyAgentTool {
  return {
    label: "Ask User Question",
    name: "ask_user_question",
    displaySummary: "Ask the user a structured question",
    description: ASK_USER_QUESTION_DESCRIPTION,
    parameters: AskUserQuestionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      for (const key of Object.keys(params)) {
        if (key !== "questions") {
          throw new ToolInputError(`unknown field '${key}'`);
        }
      }
      const rawList = params.questions;
      if (!Array.isArray(rawList) || rawList.length === 0) {
        throw new ToolInputError("questions required");
      }
      if (rawList.length > MAX_QUESTIONS) {
        throw new ToolInputError(`at most ${MAX_QUESTIONS} questions are allowed`);
      }
      const rawQuestions = rawList.map((entry, index) => readRawQuestion(entry, index));
      const questions = normalizeQuestions(rawQuestions);

      const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim() || null;
      const { wait } = getGlobalQuestionManager().register({
        sessionKey,
        agentId: options.sessionAgentId ?? null,
        turnSourceChannel: options.agentChannel ?? null,
        turnSourceTo: options.agentTo ?? null,
        turnSourceAccountId: options.agentAccountId ?? null,
        turnSourceThreadId: options.agentThreadId ?? null,
        questions,
      });

      const answers = await wait;
      if (!answers) {
        // Expired without an answer (gateway shutdown/restart or explicit expiry).
        return jsonResult({ status: "expired", answers: {} });
      }
      return jsonResult({ status: "answered", answers });
    },
  };
}
