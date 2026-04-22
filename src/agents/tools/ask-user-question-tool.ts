/**
 * PR-10: `ask_user_question` tool — surfaces a clarifying question to
 * the user via the same approval-card pipeline that exit_plan_mode
 * uses (kind: "plugin"). The user picks one of N options (or types
 * free text when allowed), and the answer arrives in the next agent
 * turn as a synthetic user message tagged `[QUESTION_ANSWER]`.
 *
 * Plan-mode safety: questions DO NOT exit plan mode. The session
 * stays in plan mode while waiting; the answer just unblocks the
 * agent's next turn. Use this when you need a tradeoff resolution
 * before submitting a plan, NOT for confirmation requests (that's
 * what exit_plan_mode does).
 *
 * Channel parity: the same approval-card payload renders as inline
 * buttons in the Control UI (today) and Telegram (PR-11), and as a
 * `/plan answer <choice>` text command on plain channels.
 */
import { Type } from "@sinclair/typebox";
import {
  ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY,
  describeAskUserQuestionTool,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam } from "./common.js";

// PR-10 review fix (Copilot #3104741583 / #3105169120): re-export the
// preset so existing callers that imported the constant from this
// module keep working, but the canonical definition lives in
// tool-description-presets.ts (single source of truth — same pattern
// as enter_plan_mode / exit_plan_mode display summaries).
export { ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY };

const AskUserQuestionToolSchema = Type.Object(
  {
    question: Type.String({
      description:
        "The question to ask the user (one or two short sentences). Examples: " +
        '"Should I ship this as 1 PR or split into 3?", "Preserve the legacy ' +
        'config path or migrate it?"',
    }),
    options: Type.Array(Type.String(), {
      minItems: 2,
      maxItems: 6,
      description:
        "2-6 selectable answer options. Each is one short phrase the user can " +
        "click without re-reading the question. The chosen option's text is " +
        "echoed back in the agent's next turn.",
    }),
    allowFreetext: Type.Optional(
      Type.Boolean({
        description:
          "When true, an 'Other...' affordance is added so the user can type " +
          "a custom answer. Use this when your N options might not cover the " +
          "user's intent. Defaults to false (locked to the N options).",
      }),
    ),
  },
  // Copilot review #68939 (2026-04-19): align with `plan_mode_status`
  // and `enter_plan_mode` schema-hardening direction.
  { additionalProperties: false },
);

export interface CreateAskUserQuestionToolOptions {
  /** Stable run identifier — used to scope question approvals to the run. */
  runId?: string;
}

export function createAskUserQuestionTool(
  _options?: CreateAskUserQuestionToolOptions,
): AnyAgentTool {
  return {
    label: "Ask User Question",
    name: "ask_user_question",
    displaySummary: ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY,
    description: describeAskUserQuestionTool(),
    parameters: AskUserQuestionToolSchema,
    execute: async (toolCallId, args, _signal) => {
      const params = args as Record<string, unknown>;
      const question = readStringParam(params, "question", { required: true });
      if (!question || question.trim().length === 0) {
        throw new ToolInputError("question required (cannot ask an empty question)");
      }
      const rawOptions = params.options;
      if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
        throw new ToolInputError("options required (provide 2-6 selectable answers)");
      }
      const options = rawOptions
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (options.length < 2) {
        throw new ToolInputError("options must contain at least 2 non-empty strings");
      }
      if (options.length > 6) {
        throw new ToolInputError("options must contain at most 6 entries (UI cap)");
      }
      // Reject duplicate option text — would create ambiguous routing
      // when the user picks one (we'd not know which to echo back).
      const seen = new Set<string>();
      for (const opt of options) {
        if (seen.has(opt)) {
          throw new ToolInputError(`options contain duplicate text: "${opt}"`);
        }
        seen.add(opt);
      }
      const allowFreetext =
        typeof params.allowFreetext === "boolean" ? params.allowFreetext : false;
      // PR-10 review H5: derive questionId deterministically from
      // `toolCallId` so the tool result is byte-stable across replays.
      // Random UUIDs would invalidate prompt-cache prefixes if the
      // tool result is ever re-replayed (transcript repair, retries).
      // The toolCallId is already stable for a given call.
      const questionId = `q-${toolCallId}`;
      // Return non-empty content (lossless-claw paired-tool-result fix).
      // The runtime intercept (pi-embedded-subscribe.handlers.tools.ts)
      // detects this tool result and emits a question approval event
      // via the existing kind:"plugin" approval pipeline.
      const text = `Question submitted to user: "${question.trim()}" (${options.length} options).`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: "question_submitted" as const,
          questionId,
          question: question.trim(),
          options,
          allowFreetext,
        },
      };
    },
  };
}
