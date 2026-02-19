import {
  extractThinkingFromTaggedStream,
  formatReasoningMessage,
} from "../agents/pi-embedded-utils.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";

const REASONING_MESSAGE_PREFIX = "Reasoning:\n";
const REASONING_TAG_PREFIXES = [
  "<think",
  "<thinking",
  "<thought",
  "<antthinking",
  "</think",
  "</thinking",
  "</thought",
  "</antthinking",
];

function isPartialReasoningTagPrefix(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  if (!trimmed.startsWith("<")) {
    return false;
  }
  if (trimmed.includes(">")) {
    return false;
  }
  return REASONING_TAG_PREFIXES.some((prefix) => prefix.startsWith(trimmed));
}

export type TelegramReasoningSplit = {
  reasoningText?: string;
  answerText?: string;
};

export function splitTelegramReasoningText(text?: string): TelegramReasoningSplit {
  if (typeof text !== "string") {
    return {};
  }

  const trimmed = text.trim();
  if (isPartialReasoningTagPrefix(trimmed)) {
    return {};
  }
  if (
    trimmed.startsWith(REASONING_MESSAGE_PREFIX) &&
    trimmed.length > REASONING_MESSAGE_PREFIX.length
  ) {
    return { reasoningText: trimmed };
  }

  const taggedReasoning = extractThinkingFromTaggedStream(text);
  const strippedAnswer = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });

  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text };
  }

  const reasoningText = taggedReasoning ? formatReasoningMessage(taggedReasoning) : undefined;
  const answerText = strippedAnswer || undefined;
  return { reasoningText, answerText };
}

export type BufferedFinalAnswer = {
  payload: ReplyPayload;
  text: string;
};

export function createTelegramReasoningStepState() {
  let reasoningHint = false;
  let reasoningDelivered = false;
  let bufferedFinalAnswer: BufferedFinalAnswer | undefined;

  const noteReasoningHint = () => {
    reasoningHint = true;
  };

  const noteReasoningDelivered = () => {
    reasoningHint = true;
    reasoningDelivered = true;
  };

  const shouldBufferFinalAnswer = () => {
    return reasoningHint && !reasoningDelivered && !bufferedFinalAnswer;
  };

  const bufferFinalAnswer = (value: BufferedFinalAnswer) => {
    bufferedFinalAnswer = value;
  };

  const takeBufferedFinalAnswer = (): BufferedFinalAnswer | undefined => {
    const value = bufferedFinalAnswer;
    bufferedFinalAnswer = undefined;
    return value;
  };

  const resetForNextStep = () => {
    reasoningHint = false;
    reasoningDelivered = false;
    bufferedFinalAnswer = undefined;
  };

  return {
    noteReasoningHint,
    noteReasoningDelivered,
    shouldBufferFinalAnswer,
    bufferFinalAnswer,
    takeBufferedFinalAnswer,
    resetForNextStep,
  };
}
