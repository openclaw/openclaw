import type { ReplyPayload } from "../../../auto-reply/types.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";

type SlackEitherOrQuestion = {
  leftOption: string;
  rightOption: string;
};

const BOTH_OR_NEITHER_RE = /\b(both|neither)\b/i;
const DEPENDS_RE = /\b(?:it\s+)?depends\b/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatching(value: string): string {
  return normalizeWhitespace(value.toLowerCase().replace(/[^a-z0-9\s]/gi, " "));
}

function cleanOption(value: string): string {
  return normalizeWhitespace(value.replace(/^[\s"'`([{<]+|[\s"'`)>}\].,!?:;]+$/g, ""));
}

function isLikelyOption(value: string): boolean {
  if (!value) {
    return false;
  }
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8 && /[a-z0-9]/i.test(value);
}

function extractEitherOrQuestion(text?: string): SlackEitherOrQuestion | null {
  const source = normalizeWhitespace(stripSlackMentionsForCommandDetection(text ?? ""));
  if (!source || !source.includes("?") || !/\bor\b/i.test(source)) {
    return null;
  }

  const candidate = source
    .split("?")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .toReversed()
    .find((chunk) => /\bor\b/i.test(chunk));
  if (!candidate) {
    return null;
  }

  const match = candidate.match(/(.+?)\s+\bor\b\s+(.+)/i);
  if (!match) {
    return null;
  }

  const leftOption = cleanOption(match[1] ?? "");
  const rightOption = cleanOption(match[2] ?? "");
  if (!isLikelyOption(leftOption) || !isLikelyOption(rightOption)) {
    return null;
  }

  return { leftOption, rightOption };
}

function hasOptionMention(replyText: string, option: string): boolean {
  const normalizedReply = normalizeForMatching(replyText);
  const normalizedOption = normalizeForMatching(option);
  if (!normalizedReply || !normalizedOption) {
    return false;
  }
  return normalizedReply.includes(normalizedOption);
}

function resolveDirectAnswerToken(params: {
  replyText: string;
  question: SlackEitherOrQuestion;
}): string | null {
  const hasLeft = hasOptionMention(params.replyText, params.question.leftOption);
  const hasRight = hasOptionMention(params.replyText, params.question.rightOption);

  if (hasLeft && hasRight) {
    return "both";
  }
  if (hasLeft) {
    return params.question.leftOption;
  }
  if (hasRight) {
    return params.question.rightOption;
  }

  if (BOTH_OR_NEITHER_RE.test(params.replyText)) {
    const value = params.replyText.match(BOTH_OR_NEITHER_RE)?.[1]?.toLowerCase();
    return value === "neither" ? "neither" : "both";
  }
  if (DEPENDS_RE.test(params.replyText)) {
    return "it depends";
  }

  return null;
}

export function enforceSlackDirectEitherOrAnswer(params: {
  questionText?: string;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (/^direct\s+answer\s*:/i.test(replyText)) {
    return params.payload;
  }

  const question = extractEitherOrQuestion(params.questionText);
  if (!question) {
    return params.payload;
  }

  const directAnswer = resolveDirectAnswerToken({ replyText, question });
  if (directAnswer) {
    return params.payload;
  }

  return {
    ...params.payload,
    text: `Direct answer: it depends.\n\n${replyText}`,
  };
}

export { extractEitherOrQuestion };
