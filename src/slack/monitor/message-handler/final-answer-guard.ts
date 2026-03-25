import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { matchesHumanCorrection } from "../../../sre/patterns.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import { findSlackIncidentHeaderLineIndex } from "../incident-format.js";
import {
  hasSlackProgressOnlyPrefix,
  SLACK_SUBSTANTIVE_SIGNAL_RE,
  SLACK_SUMMARY_SECTION_RE,
} from "./progress-patterns.js";

type SlackEitherOrQuestion = {
  leftOption: string;
  rightOption: string;
};

const BOTH_OR_NEITHER_RE = /\b(both|neither)\b/i;
const DEPENDS_RE = /\b(?:it\s+)?depends\b/i;
const DISPROVED_THEORY_RE = /^disproved theory:/im;
const STATUS_LABEL_RE = /^(?:\*Status:\*|_Status:_)/i;
// 12 KB covers typical incident/PR summaries while letting large evidence blobs
// (logs, traces, pasted transcripts) bypass suppression. Replies at or under
// the cutoff still go through the guard; oversized replies deliberately bypass
// suppression so the runtime favors delivery over a risky false positive. Keep
// the cutoff ahead of the regex-heavy path so giant inputs short-circuit early.
const SLACK_PROGRESS_GUARD_MAX_CHARS = 12_000;
const SLACK_EITHER_OR_MAX_OPTION_WORDS = 8;
const DEFAULT_DISPROVED_THEORY_LINE =
  "Disproved theory: earlier thread theory was wrong; conclusions below use the latest human correction and fresh evidence.";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatching(value: string): string {
  return normalizeWhitespace(value.toLowerCase().replace(/[^a-z0-9\s]/gi, " "));
}

function normalizeSlackGuardText(value: string): string {
  // Repeat the size guard here in case future callers reach this helper
  // directly instead of going through shouldSuppressSlackProgressReply().
  if (!value || value.length > SLACK_PROGRESS_GUARD_MAX_CHARS) {
    return "";
  }
  return normalizeWhitespace(
    stripSlackMentionsForCommandDetection(
      value.replace(/\p{Dash_Punctuation}/gu, "-").replace(/`/g, ""),
    ),
  );
}

function cleanOption(value: string): string {
  return normalizeWhitespace(value.replace(/^[\s"'`([{<]+|[\s"'`)>}\].,!?:;]+$/g, ""));
}

function isLikelyOption(value: string): boolean {
  if (!value) {
    return false;
  }
  const words = value.split(/\s+/).filter(Boolean);
  return (
    words.length > 0 && words.length <= SLACK_EITHER_OR_MAX_OPTION_WORDS && /[a-z0-9]/i.test(value)
  );
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

function extractSlackLeadContentLine(replyText: string): string {
  for (const rawLine of replyText.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^<@[^>]*>$/.test(trimmed) || /^\[\[[^\]]+\]\]$/.test(trimmed)) {
      continue;
    }
    return normalizeSlackGuardText(trimmed);
  }
  return "";
}

function hasSlackSubstantiveSignal(replyText: string): boolean {
  return (
    SLACK_SUMMARY_SECTION_RE.test(replyText) ||
    DISPROVED_THEORY_RE.test(replyText) ||
    /^direct\s+answer\s*:/im.test(replyText) ||
    SLACK_SUBSTANTIVE_SIGNAL_RE.test(replyText)
  );
}

/**
 * Returns true when a Slack reply is just progress chatter with no substantive
 * incident/PR/CI signal and should therefore be suppressed in final-only
 * incident thread contexts.
 */
export function shouldSuppressSlackProgressReply(replyText?: string): boolean {
  if (!replyText) {
    return false;
  }
  // Bail out before trim/regex work when the raw input is already oversized.
  if (replyText.length > SLACK_PROGRESS_GUARD_MAX_CHARS) {
    return false;
  }
  const trimmed = replyText.trim();
  if (!trimmed) {
    return false;
  }
  if (hasSlackSubstantiveSignal(trimmed)) {
    return false;
  }
  const leadLine = extractSlackLeadContentLine(trimmed);
  if (!leadLine) {
    return false;
  }
  return hasSlackProgressOnlyPrefix(leadLine);
}

export function applySlackFinalReplyGuards(params: {
  questionText?: string;
  inboundText?: string;
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  payload: ReplyPayload;
}): ReplyPayload {
  const directAnswerPayload = enforceSlackDirectEitherOrAnswer({
    questionText: params.questionText,
    payload: params.payload,
  });
  const disprovedTheoryPayload = enforceSlackDisprovedTheoryRetraction({
    inboundText: params.inboundText,
    incidentRootOnly: params.incidentRootOnly,
    isThreadReply: params.isThreadReply,
    payload: directAnswerPayload,
  });
  return enforceSlackNoProgressOnlyReply({
    incidentRootOnly: params.incidentRootOnly,
    isThreadReply: params.isThreadReply,
    payload: disprovedTheoryPayload,
  });
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

export function shouldRequireSlackDisprovedTheory(params: {
  inboundText?: string;
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
}): boolean {
  // Human corrections in incident-root-only threads must force an explicit
  // retraction line so follow-up RCA does not silently build on stale bot
  // theories from earlier in the thread.
  if (!params.incidentRootOnly || !params.isThreadReply) {
    return false;
  }
  const source = normalizeWhitespace(
    stripSlackMentionsForCommandDetection(params.inboundText ?? ""),
  );
  if (!source) {
    return false;
  }
  return matchesHumanCorrection(source);
}

function injectSlackDisprovedTheoryLine(replyText: string): string {
  if (DISPROVED_THEORY_RE.test(replyText)) {
    return replyText.trim();
  }
  const lines = replyText.trim().split("\n");
  const incidentIndex = findSlackIncidentHeaderLineIndex(replyText);
  if (lines.length === 0 || incidentIndex < 0) {
    return replyText.trim();
  }
  const statusIndex = lines.findIndex(
    (line, index) => index > incidentIndex && STATUS_LABEL_RE.test(line.trim()),
  );
  const insertAt = statusIndex >= 0 ? statusIndex + 1 : incidentIndex + 1;
  const boundedInsertAt = Math.min(Math.max(insertAt, incidentIndex + 1), lines.length);
  return [
    ...lines.slice(0, boundedInsertAt),
    DEFAULT_DISPROVED_THEORY_LINE,
    ...lines.slice(boundedInsertAt),
  ].join("\n");
}

export function enforceSlackDisprovedTheoryRetraction(params: {
  inboundText?: string;
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (!shouldRequireSlackDisprovedTheory(params)) {
    return params.payload;
  }
  if (DISPROVED_THEORY_RE.test(replyText)) {
    return params.payload;
  }
  if (findSlackIncidentHeaderLineIndex(replyText) < 0) {
    return params.payload;
  }

  return {
    ...params.payload,
    text: injectSlackDisprovedTheoryLine(replyText),
  };
}

export function enforceSlackNoProgressOnlyReply(params: {
  incidentRootOnly?: boolean;
  isThreadReply?: boolean;
  payload: ReplyPayload;
}): ReplyPayload {
  const rawText = params.payload.text;
  const replyText = typeof rawText === "string" ? rawText.trim() : "";
  if (!replyText || params.payload.isError) {
    return params.payload;
  }
  if (!params.incidentRootOnly || !params.isThreadReply) {
    return params.payload;
  }
  if (!shouldSuppressSlackProgressReply(replyText)) {
    return params.payload;
  }
  return {
    ...params.payload,
    text: SILENT_REPLY_TOKEN,
  };
}

export { extractEitherOrQuestion };
