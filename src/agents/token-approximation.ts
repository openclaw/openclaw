import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "../utils/cjk-chars.js";

/**
 * Code tends to tokenize more densely than prose because punctuation,
 * operators, and identifiers break into shorter tokenizer fragments.
 */
export const CODE_CHARS_PER_TOKEN_ESTIMATE = 2.5;
const INLINE_CODE_CHARS_PER_TOKEN_ESTIMATE = 3;
const IMAGE_TOKEN_CHAR_ESTIMATE = 8_000;
const TOOL_CALL_OVERHEAD_TOKENS = 12;

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

function normalizeCharsPerTokenEstimate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : CHARS_PER_TOKEN_ESTIMATE;
}

function inflateCharsForTokenDensity(text: string, charsPerTokenEstimate: number): number {
  if (!text) {
    return 0;
  }
  const adjustedChars = estimateStringChars(text);
  const normalized = normalizeCharsPerTokenEstimate(charsPerTokenEstimate);
  if (normalized >= CHARS_PER_TOKEN_ESTIMATE) {
    return adjustedChars;
  }
  const multiplier = CHARS_PER_TOKEN_ESTIMATE / normalized;
  return Math.ceil(adjustedChars * multiplier);
}

function estimateInlineCodeTokenChars(text: string): number {
  if (!text) {
    return 0;
  }

  let total = 0;
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_RE)) {
    const segment = match[0];
    const index = match.index ?? 0;
    total += inflateCharsForTokenDensity(text.slice(lastIndex, index), CHARS_PER_TOKEN_ESTIMATE);
    total += inflateCharsForTokenDensity(segment, INLINE_CODE_CHARS_PER_TOKEN_ESTIMATE);
    lastIndex = index + segment.length;
  }
  total += inflateCharsForTokenDensity(text.slice(lastIndex), CHARS_PER_TOKEN_ESTIMATE);
  return total;
}

/**
 * Estimate weighted characters for a text string so that dividing by
 * {@link CHARS_PER_TOKEN_ESTIMATE} yields a reasonable token approximation.
 *
 * Prose uses the shared CJK-aware heuristic, while fenced and inline code are
 * inflated because code tends to tokenize more densely than prose.
 */
export function estimateTextTokenChars(text: string): number {
  if (!text) {
    return 0;
  }

  let total = 0;
  let lastIndex = 0;
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    const segment = match[0];
    const index = match.index ?? 0;
    total += estimateInlineCodeTokenChars(text.slice(lastIndex, index));
    total += inflateCharsForTokenDensity(segment, CODE_CHARS_PER_TOKEN_ESTIMATE);
    lastIndex = index + segment.length;
  }
  total += estimateInlineCodeTokenChars(text.slice(lastIndex));
  return total;
}

/**
 * Fast token approximation for a text string.
 */
export function estimateTextTokensApprox(text: string): number {
  return estimateTokensFromChars(estimateTextTokenChars(text));
}

export function estimateUnknownTokenChars(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokenChars(value);
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ? estimateTextTokenChars(serialized) : 0;
  } catch {
    return 256;
  }
}

export function estimateUnknownTokensApprox(value: unknown): number {
  return estimateTokensFromChars(estimateUnknownTokenChars(value));
}

function estimateContentTokenChars(content: unknown): number {
  if (typeof content === "string") {
    return estimateTextTokenChars(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }

  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      arguments?: unknown;
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      chars += estimateTextTokenChars(typed.text);
      continue;
    }
    if (
      (typed.type === "thinking" || typed.type === "redacted_thinking") &&
      typeof typed.thinking === "string"
    ) {
      chars += estimateTextTokenChars(typed.thinking);
      continue;
    }
    if (typed.type === "toolCall") {
      chars +=
        estimateUnknownTokenChars(typed.arguments) +
        TOOL_CALL_OVERHEAD_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
      continue;
    }
    if (typed.type === "image") {
      chars += IMAGE_TOKEN_CHAR_ESTIMATE;
      continue;
    }
    chars += estimateUnknownTokenChars(block);
  }
  return chars;
}

/**
 * Approximate the input-side token cost of a single message before it is sent
 * to the model API.
 */
export function estimateMessageTokensApprox(message: AgentMessage): number {
  if (!message || typeof message !== "object") {
    return 0;
  }

  if (message.role === "user" || message.role === "assistant") {
    return estimateTokensFromChars(estimateContentTokenChars(message.content));
  }

  const role = (message as { role?: unknown }).role;
  const type = (message as { type?: unknown }).type;
  if (role === "toolResult" || role === "tool" || type === "toolResult") {
    const contentChars = estimateContentTokenChars((message as { content?: unknown }).content);
    const detailsChars = estimateUnknownTokenChars((message as { details?: unknown }).details);
    return estimateTokensFromChars(contentChars + detailsChars);
  }

  return estimateTokensFromChars(estimateUnknownTokenChars(message));
}

/**
 * Approximate the input-side token cost of a message array.
 */
export function estimateMessagesTokensApprox(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokensApprox(message), 0);
}
