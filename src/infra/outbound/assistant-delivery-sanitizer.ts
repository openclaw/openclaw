import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";

export type AssistantDeliverySanitizerRole = "assistant" | "user" | "system" | "tool";

export type AssistantDeliverySanitizerOptions = {
  role?: AssistantDeliverySanitizerRole;
  /**
   * When true, visible channel surfaces may keep tagged thinking text. The
   * default is false because most outbound channels do not have a separate
   * reasoning lane and must never expose model-private reasoning accidentally.
   */
  thinkingEnabled?: boolean;
  reasoningEnabled?: boolean;
};

const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "thoughts"];
const THINKING_TAG_PATTERN = new RegExp(
  `<\\s*(${THINKING_TAG_NAMES.join("|")})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`,
  "gi",
);
const FENCE_PATTERN = /^\s*(```|~~~)/;
const MIXED_REASONING_FINAL_PATTERN =
  /^\s*(?:reasoning|thinking|thoughts?)\s*:\s*[\s\S]*?(?:\n\s*(?:final(?:\s+answer)?|answer|response)\s*:\s*)([\s\S]+)$/i;
const REASONING_ONLY_PATTERN = /^\s*(?:reasoning|thinking|thoughts?)\s*:\s*[\s\S]*$/i;

function canShowThinking(options: AssistantDeliverySanitizerOptions): boolean {
  return options.thinkingEnabled === true || options.reasoningEnabled === true;
}

function isAssistantRole(options: AssistantDeliverySanitizerOptions): boolean {
  return (options.role ?? "assistant") === "assistant";
}

function stripTaggedThinkingOutsideCodeBlocks(text: string): string {
  const lines = text.split(/(?<=\n)/);
  let inFence = false;
  let changed = false;
  let outsideBuffer = "";
  const out: string[] = [];
  const flushOutside = () => {
    if (!outsideBuffer) {
      return;
    }
    const stripped = outsideBuffer.replace(THINKING_TAG_PATTERN, "");
    changed ||= stripped !== outsideBuffer;
    out.push(stripped);
    outsideBuffer = "";
  };
  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      flushOutside();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    outsideBuffer += line;
  }
  flushOutside();
  return changed ? out.join("") : text;
}

export function sanitizeAssistantTextForDelivery(
  text: string,
  options: AssistantDeliverySanitizerOptions = {},
): string | null {
  if (!isAssistantRole(options) || canShowThinking(options)) {
    return text;
  }
  if (!text.trim()) {
    return text;
  }
  let sanitized = stripTaggedThinkingOutsideCodeBlocks(text);
  const mixedReasoning = MIXED_REASONING_FINAL_PATTERN.exec(sanitized);
  if (mixedReasoning?.[1]?.trim()) {
    sanitized = mixedReasoning[1];
  } else if (REASONING_ONLY_PATTERN.test(sanitized)) {
    return null;
  }
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n").trim();
  return sanitized ? sanitized : null;
}

export function sanitizeAssistantForDelivery<T extends ReplyPayload>(
  payload: T,
  options: AssistantDeliverySanitizerOptions = {},
): T | null {
  if (!isAssistantRole(options)) {
    return payload;
  }
  if (payload.isReasoning === true && !canShowThinking(options)) {
    return null;
  }
  if (typeof payload.text !== "string") {
    return payload;
  }
  const text = sanitizeAssistantTextForDelivery(payload.text, options);
  if (text === payload.text) {
    return payload;
  }
  if (text === null) {
    const withoutText = copyReplyPayloadMetadata(payload, { ...payload, text: undefined });
    return hasReplyPayloadContent(withoutText) ? (withoutText as T) : null;
  }
  return copyReplyPayloadMetadata(payload, { ...payload, text }) as T;
}
