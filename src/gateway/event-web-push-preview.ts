import { findGraphemeChunkEnd } from "@openclaw/normalization-core/grapheme";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebPushContentPreview } from "../../packages/gateway-protocol/src/schema/push.js";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/schema/questions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeExecApprovalDisplayText } from "../infra/exec-approval-text-sanitize.js";
import { redactToolPayloadTextWithConfig } from "../logging/redact.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";

const PREVIEW_TEXT_LIMIT = 240;
const PREVIEW_INPUT_LIMIT = 64 * 1024;

function previewId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && value === value.trim()
  );
}

function displayText(text: string, cfg: OpenClawConfig): string {
  // Redact before any lossy formatting or truncation can hide a credential's context.
  return sanitizeExecApprovalDisplayText(
    flattenMarkdownToPlainText(redactToolPayloadTextWithConfig(text, cfg.logging)),
  );
}

/** Only the exact terminal event's visible answer is eligible; never read history. */
export function resolveWebPushAnswerPreview(
  payload: unknown,
  sessionKeys: readonly string[],
  cfg: OpenClawConfig,
  answerPreviewText?: string,
): WebPushContentPreview | undefined {
  if (
    !isRecord(payload) ||
    payload.state !== "final" ||
    payload.yielded === true ||
    sessionKeys.length !== 1 ||
    payload.sessionKey !== sessionKeys[0] ||
    !previewId(payload.sessionKey) ||
    !previewId(payload.runId) ||
    payload.stopReason === "error" ||
    payload.stopReason === "aborted"
  ) {
    return undefined;
  }
  const message = payload.message;
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    // Some terminal producers already apply the history display cap. Missing
    // suffixes cannot be safely recovered or checked by credential patterns.
    (isRecord(message["__openclaw"]) && message["__openclaw"].truncated === true) ||
    isTranscriptOnlyOpenClawAssistantMessage(message) ||
    isOpenClawMessageToolMirrorAssistantMessage(message)
  ) {
    return undefined;
  }
  // Keep the complete selected text for redaction; the history cap can cut off
  // a credential delimiter before a configured pattern has a chance to match.
  // The live terminal producer retains its full projected answer when transcript
  // persistence empties the display tail. Other producers retain their display overrides.
  const answer = stripSuppressedControlReplyToken(
    answerPreviewText ??
      resolveRawAssistantAnswerText(
        projectChatDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER }),
      ),
  );
  if (!answer || answer.length > PREVIEW_INPUT_LIMIT) {
    return undefined;
  }
  let text = displayText(answer, cfg);
  if (text.length > PREVIEW_TEXT_LIMIT) {
    const end = findGraphemeChunkEnd(
      text,
      0,
      PREVIEW_TEXT_LIMIT - 1,
      PREVIEW_TEXT_LIMIT - 1,
      false,
    );
    text = end > 0 ? `${text.slice(0, end).trimEnd()}…` : "";
  }
  return text
    ? { version: 1, kind: "answer", sessionKey: payload.sessionKey, runId: payload.runId, text }
    : undefined;
}

/** Receives a canonical record only after the question owner admits this recipient. */
export function resolveWebPushQuestionPreview(
  record: QuestionRecord,
  cfg: OpenClawConfig,
): WebPushContentPreview | undefined {
  if (
    record.status !== "pending" ||
    !previewId(record.id) ||
    !previewId(record.sessionKey) ||
    (record.runId !== undefined && !previewId(record.runId)) ||
    record.questions.length !== 1
  ) {
    return undefined;
  }
  const question = record.questions[0];
  if (
    !question ||
    question.isSecret ||
    question.secretStore ||
    question.secretStoreExisting ||
    question.presentation ||
    question.resource ||
    question.multiSelect ||
    question.answerFormat ||
    question.allowEmpty ||
    question.defaultAnswers?.length ||
    question.url ||
    question.options.length > 3 ||
    !previewId(question.questionId) ||
    !question.question ||
    question.question.length > PREVIEW_TEXT_LIMIT ||
    displayText(question.question, cfg) !== question.question
  ) {
    return undefined;
  }
  const choices: string[] = [];
  for (const option of question.options) {
    // A changed, shortened, or hidden-value label is not the operator's exact choice.
    if (
      option.value !== undefined ||
      option.description ||
      option.thumbnail ||
      option.resourceUri ||
      option.preview ||
      !option.label ||
      option.label.length > 80 ||
      displayText(option.label, cfg) !== option.label ||
      choices.includes(option.label)
    ) {
      return undefined;
    }
    choices.push(option.label);
  }
  return {
    version: 1,
    kind: "question",
    requestId: record.id,
    sessionKey: record.sessionKey,
    ...(record.runId ? { runId: record.runId } : {}),
    expiresAtMs: record.expiresAtMs,
    question: {
      id: question.questionId,
      text: question.question,
      choices,
      allowTextReply: choices.length === 0 || question.isOther === true,
    },
  };
}
