import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import { redactToolPayloadText } from "../logging/redact.js";

export const NON_DELIVERABLE_TERMINAL_REPLY_TEXT =
  "⚠️ Agent couldn't generate a response. Please try again.";
const DEFAULT_GENERIC_TERMINAL_TOOL_RESULT_MAX_CHARS = 2_000;
const GENERIC_TERMINAL_TOOL_RESULT_TRUNCATED_SUFFIX = "\n...[truncated]";

type DeliberateSilentTerminalReplyResult = {
  meta?: {
    error?: {
      kind?: unknown;
    };
    finalAssistantRawText?: unknown;
    finalAssistantVisibleText?: unknown;
    terminalReplyKind?: unknown;
  };
};

export function hasDeliberateSilentTerminalReply(
  result: DeliberateSilentTerminalReplyResult,
): boolean {
  if (
    result.meta?.error?.kind === "hook_block" ||
    result.meta?.terminalReplyKind === "silent-empty"
  ) {
    return true;
  }
  return [result.meta?.finalAssistantRawText, result.meta?.finalAssistantVisibleText].some(
    (text) => typeof text === "string" && isSilentReplyPayloadText(text),
  );
}

export function normalizeGenericTerminalToolResultText(
  text: string | undefined,
  maxChars = DEFAULT_GENERIC_TERMINAL_TOOL_RESULT_MAX_CHARS,
): string | undefined {
  const normalized = text?.trim();
  if (!normalized) {
    return undefined;
  }
  const redacted = redactToolPayloadText(normalized);
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(
    0,
    Math.max(0, maxChars - GENERIC_TERMINAL_TOOL_RESULT_TRUNCATED_SUFFIX.length),
  )}${GENERIC_TERMINAL_TOOL_RESULT_TRUNCATED_SUFFIX}`;
}
