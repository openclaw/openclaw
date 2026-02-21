import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { stripThinkingTags } from "../format.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const shouldStripInboundMetadata = role.toLowerCase() === "user";
  const content = m.content;
  if (typeof content === "string") {
    const processed =
      role === "assistant"
        ? stripThinkingTags(content)
        : shouldStripInboundMetadata
          ? stripInboundMetadata(stripEnvelope(content))
          : stripEnvelope(content);
    return processed;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      const joined = parts.join("\n");
      const processed =
        role === "assistant"
          ? stripThinkingTags(joined)
          : shouldStripInboundMetadata
            ? stripInboundMetadata(stripEnvelope(joined))
            : stripEnvelope(joined);
      return processed;
    }
  }
  if (typeof m.text === "string") {
    const processed =
      role === "assistant"
        ? stripThinkingTags(m.text)
        : shouldStripInboundMetadata
          ? stripInboundMetadata(stripEnvelope(m.text))
          : stripEnvelope(m.text);
    return processed;
  }

  // If content is empty and this is an error response, show the formatted error
  if (m.stopReason === "error" && typeof m.errorMessage === "string") {
    return formatErrorMessage(m.errorMessage);
  }

  return null;
}

/**
 * Format raw API error messages for user-friendly display.
 */
function formatErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "LLM request failed with an unknown error.";
  }

  // Try to extract message from JSON error payload
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const jsonStr = trimmed.slice(jsonStart);
      const json = JSON.parse(jsonStr);

      // Extract nested error.message or top-level message
      let message: string | null = null;
      if (json.error && typeof json.error.message === "string") {
        message = json.error.message;
      } else if (typeof json.message === "string") {
        message = json.message;
      }

      if (message) {
        // Extract HTTP status code if present
        const httpPrefix = trimmed.slice(0, jsonStart).trim();
        const httpCode = /^\d+$/.test(httpPrefix) ? parseInt(httpPrefix, 10) : null;
        return httpCode ? `HTTP ${httpCode}: ${message}` : `LLM error: ${message}`;
      }
    } catch {
      // Fall through to default handling
    }
  }

  // Fallback: truncate long messages
  return trimmed.length > 600 ? trimmed.slice(0, 600) + "…" : trimmed;
}

export function extractTextCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractText(message);
  }
  const obj = message;
  if (textCache.has(obj)) {
    return textCache.get(obj) ?? null;
  }
  const value = extractText(message);
  textCache.set(obj, value);
  return value;
}

export function extractThinking(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      const item = p as Record<string, unknown>;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        const cleaned = item.thinking.trim();
        if (cleaned) {
          parts.push(cleaned);
        }
      }
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }

  // Back-compat: older logs may still have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) {
    return null;
  }
  const matches = [
    ...rawText.matchAll(/<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi),
  ];
  const extracted = matches.map((m) => (m[1] ?? "").trim()).filter(Boolean);
  return extracted.length > 0 ? extracted.join("\n") : null;
}

export function extractThinkingCached(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return extractThinking(message);
  }
  const obj = message;
  if (thinkingCache.has(obj)) {
    return thinkingCache.get(obj) ?? null;
  }
  const value = extractThinking(message);
  thinkingCache.set(obj, value);
  return value;
}

export function extractRawText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const item = p as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return null;
      })
      .filter((v): v is string => typeof v === "string");
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof m.text === "string") {
    return m.text;
  }
  return null;
}

export function formatReasoningMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `_${line}_`);
  return lines.length ? ["_Reasoning:_", ...lines].join("\n") : "";
}
