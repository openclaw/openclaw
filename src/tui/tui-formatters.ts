import { formatRawAssistantErrorForUi } from "../agents/pi-embedded-helpers.js";
import { stripLeadingInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripAnsi } from "../terminal/ansi.js";
import { formatTokenCount } from "../utils/usage-format.js";

const REPLACEMENT_CHAR_RE = /\uFFFD/g;
const MAX_TOKEN_CHARS = 32;
const LONG_TOKEN_RE = /\S{33,}/g;
const LONG_TOKEN_TEST_RE = /\S{33,}/;
const BINARY_LINE_REPLACEMENT_THRESHOLD = 12;
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;

function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (isAsciiControl || isC1Control) {
      return true;
    }
  }
  return false;
}

function stripControlChars(text: string): string {
  if (!hasControlChars(text)) {
    return text;
  }
  let sanitized = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const isAsciiControl = code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isC1Control = code >= 0x7f && code <= 0x9f;
    if (!isAsciiControl && !isC1Control) {
      sanitized += char;
    }
  }
  return sanitized;
}

function chunkToken(token: string, maxChars: number): string[] {
  if (token.length <= maxChars) {
    return [token];
  }
  const chunks: string[] = [];
  for (let i = 0; i < token.length; i += maxChars) {
    chunks.push(token.slice(i, i + maxChars));
  }
  return chunks;
}

function isCopySensitiveToken(token: string): boolean {
  if (URL_PREFIX_RE.test(token)) {
    return true;
  }
  if (
    token.startsWith("/") ||
    token.startsWith("~/") ||
    token.startsWith("./") ||
    token.startsWith("../")
  ) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(token) || token.startsWith("\\\\")) {
    return true;
  }
  if (token.includes("/") || token.includes("\\")) {
    return true;
  }
  return token.includes("_") && FILE_LIKE_RE.test(token);
}

function normalizeLongTokenForDisplay(token: string): string {
  // Preserve copy-sensitive tokens exactly (paths/urls/file-like names).
  if (isCopySensitiveToken(token)) {
    return token;
  }
  return chunkToken(token, MAX_TOKEN_CHARS).join(" ");
}

function redactBinaryLikeLine(line: string): string {
  const replacementCount = (line.match(REPLACEMENT_CHAR_RE) || []).length;
  if (
    replacementCount >= BINARY_LINE_REPLACEMENT_THRESHOLD &&
    replacementCount * 2 >= line.length
  ) {
    return "[binary data omitted]";
  }
  return line;
}

export function sanitizeRenderableText(text: string): string {
  if (!text) {
    return text;
  }

  const hasAnsi = text.includes("\u001b");
  const hasReplacementChars = text.includes("\uFFFD");
  const hasLongTokens = LONG_TOKEN_TEST_RE.test(text);
  const hasControls = hasControlChars(text);
  if (!hasAnsi && !hasReplacementChars && !hasLongTokens && !hasControls) {
    return text;
  }

  const withoutAnsi = hasAnsi ? stripAnsi(text) : text;
  const withoutControlChars = hasControls ? stripControlChars(withoutAnsi) : withoutAnsi;
  const redacted = hasReplacementChars
    ? withoutControlChars
        .split("\n")
        .map((line) => redactBinaryLikeLine(line))
        .join("\n")
    : withoutControlChars;
  return LONG_TOKEN_TEST_RE.test(redacted)
    ? redacted.replace(LONG_TOKEN_RE, normalizeLongTokenForDisplay)
    : redacted;
}

export function resolveFinalAssistantText(params: {
  finalText?: string | null;
  streamedText?: string | null;
}) {
  const finalText = params.finalText ?? "";
  if (finalText.trim()) {
    return finalText;
  }
  const streamedText = params.streamedText ?? "";
  if (streamedText.trim()) {
    return streamedText;
  }
  return "(no output)";
}

export function composeThinkingAndContent(params: {
  thinkingText?: string;
  contentText?: string;
  showThinking?: boolean;
}) {
  const thinkingText = params.thinkingText?.trim() ?? "";
  const contentText = params.contentText?.trim() ?? "";
  const parts: string[] = [];

  if (params.showThinking && thinkingText) {
    parts.push(`[thinking]\n${thinkingText}`);
  }
  if (contentText) {
    parts.push(contentText);
  }

  return parts.join("\n\n").trim();
}

/**
 * Extract ONLY thinking blocks from message content.
 * Model-agnostic: returns empty string if no thinking blocks exist.
 */
export function extractThinkingFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") {
    return "";
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "thinking" && typeof rec.thinking === "string") {
      parts.push(sanitizeRenderableText(rec.thinking));
    }
  }
  return parts.join("\n").trim();
}

/**
 * Extract ONLY text content blocks from message (excludes thinking).
 * Model-agnostic: works for any model with text content blocks.
 */
export function extractContentFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") {
    return sanitizeRenderableText(content).trim();
  }

  // Check for error BEFORE returning empty for non-array content
  if (!Array.isArray(content)) {
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
    if (stopReason === "error") {
      const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
      return formatRawAssistantErrorForUi(errorMessage);
    }
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(sanitizeRenderableText(rec.text));
    }
  }

  // If no text blocks found, check for error
  if (parts.length === 0) {
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
    if (stopReason === "error") {
      const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
      return formatRawAssistantErrorForUi(errorMessage);
    }
  }

  return parts.join("\n").trim();
}

function extractTextBlocks(content: unknown, opts?: { includeThinking?: boolean }): string {
  if (typeof content === "string") {
    return sanitizeRenderableText(content).trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const thinkingParts: string[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(sanitizeRenderableText(record.text));
    }
    if (
      opts?.includeThinking &&
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      thinkingParts.push(sanitizeRenderableText(record.thinking));
    }
  }

  return composeThinkingAndContent({
    thinkingText: thinkingParts.join("\n").trim(),
    contentText: textParts.join("\n").trim(),
    showThinking: opts?.includeThinking ?? false,
  });
}

export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const text = extractTextBlocks(record.content, opts);
  if (text) {
    if (record.role === "user") {
      return stripLeadingInboundMetadata(text);
    }
    return text;
  }

  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason !== "error") {
    return "";
  }

  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
  return formatRawAssistantErrorForUi(errorMessage);
}

export function isCommandMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  return (message as Record<string, unknown>).command === true;
}

export function formatTokens(total?: number | null, context?: number | null) {
  if (total == null && context == null) {
    return "tokens ?";
  }
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) {
    return `tokens ${totalLabel}`;
  }
  const pct =
    typeof total === "number" && context > 0
      ? Math.min(999, Math.round((total / context) * 100))
      : null;
  return `tokens ${totalLabel}/${formatTokenCount(context)}${pct !== null ? ` (${pct}%)` : ""}`;
}

export function formatContextUsageLine(params: {
  total?: number | null;
  context?: number | null;
  remaining?: number | null;
  percent?: number | null;
}) {
  const totalLabel = typeof params.total === "number" ? formatTokenCount(params.total) : "?";
  const ctxLabel = typeof params.context === "number" ? formatTokenCount(params.context) : "?";
  const pct = typeof params.percent === "number" ? Math.min(999, Math.round(params.percent)) : null;
  const remainingLabel =
    typeof params.remaining === "number" ? `${formatTokenCount(params.remaining)} left` : null;
  const pctLabel = pct !== null ? `${pct}%` : null;
  const extra = [remainingLabel, pctLabel].filter(Boolean).join(", ");
  return `tokens ${totalLabel}/${ctxLabel}${extra ? ` (${extra})` : ""}`;
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}
