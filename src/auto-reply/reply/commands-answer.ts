// Implements the /answer command: the universal text fallback for resolving a
// pending ask_user_question from any channel that lacks (or on top of) inline
// buttons. Resolves the session's pending question via the process-global
// QuestionManager using the shared harness answer parser.
import { buildAgentHarnessUserInputAnswers } from "../../agents/harness/user-input-bridge.js";
import {
  getGlobalQuestionManager,
  type QuestionAnswers,
  type QuestionRecord,
} from "../../gateway/question-manager.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const ANSWER_COMMAND_REGEX = /^\/?answer(?:\s|$)/i;

const ANSWER_USAGE_TEXT =
  "Usage: /answer <option number or text> (for multi-part questions use 'header: answer' lines)";

/** Parses `/answer <rest>`; returns null when the body is not an /answer command. */
export function parseAnswerCommand(raw: string): { text: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(ANSWER_COMMAND_REGEX);
  if (!match) {
    return null;
  }
  return { text: trimmed.slice(match[0].length).trim() };
}

/** Newest visible pending question record for this session, if any. */
export function findPendingQuestionForSession(sessionKey: string): QuestionRecord | undefined {
  const records = getGlobalQuestionManager().list(
    (record) => (record.sessionKey ?? "") === sessionKey,
  );
  return records.toSorted((a, b) => b.createdAtMs - a.createdAtMs)[0];
}

/** Maps free-text/numbered answer input onto the record's questions. */
export function buildQuestionAnswersFromText(
  record: QuestionRecord,
  text: string,
): QuestionAnswers {
  const built = buildAgentHarnessUserInputAnswers(record.questions, text);
  const answers: QuestionAnswers = {};
  for (const [id, value] of Object.entries(built.answers)) {
    answers[id] = { text: value.answers[0] ?? "" };
  }
  return answers;
}

/** Command handler for /answer <n|text> resolving a pending question. */
export const handleAnswerCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAnswerCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/answer");
  if (unauthorized) {
    return unauthorized;
  }

  // Pending questions live only in the in-memory manager, so there is no session
  // store to read stale here — the lookup is always against live registrations.
  const record = findPendingQuestionForSession(params.sessionKey);
  if (!record) {
    return { shouldContinue: false, reply: { text: "No pending question to answer." } };
  }
  if (!parsed.text) {
    return { shouldContinue: false, reply: { text: ANSWER_USAGE_TEXT } };
  }

  const answers = buildQuestionAnswersFromText(record, parsed.text);
  const resolvedBy = `${params.command.channel}:${params.command.senderId ?? "unknown"}`;
  const ok = getGlobalQuestionManager().resolve(record.id, answers, resolvedBy);
  if (!ok) {
    return {
      shouldContinue: false,
      reply: { text: "That question was already answered or is no longer pending." },
    };
  }
  return { shouldContinue: false, reply: { text: "✅ Answer submitted." } };
};
