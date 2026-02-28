import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { stripThinkingTags } from "../format.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

/**
 * Strips <relevant-memories> blocks from text.
 * These blocks are injected by the memory-lancedb extension and should not
 * be displayed in the Web UI - they're AI-facing context only.
 */
function stripRelevantMemoriesBlocks(text: string): string {
  if (!text || !text.includes("<relevant-memories>")) {
    return text;
  }
  // Match <relevant-memories>...</relevant-memories> blocks
  // The content between tags can span multiple lines
  return text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, "").trim();
}

/**
 * Strips internal system event messages that should not be displayed in Web UI.
 * These include model switch notifications and other OpenClaw internal events.
 */
function stripInternalSystemEvents(text: string): string {
  if (!text) {
    return text;
  }
  // Strip "System:" prefixed messages that are internal to OpenClaw
  // Examples: "System: Model switched to GLM (zai/glm-5)."
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    // Keep non-System lines
    if (!line.startsWith("System:")) {
      return true;
    }
    // Filter out internal system messages
    const lowerLine = line.toLowerCase();
    if (
      lowerLine.includes("model switched") ||
      lowerLine.includes("auto-compaction") ||
      lowerLine.includes("post-compaction context")
    ) {
      return false;
    }
    return true;
  });
  return filtered.join("\n").trim();
}

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const shouldStripInboundMetadata = role.toLowerCase() === "user";
  const isAssistant = role === "assistant";

  // Helper to apply all necessary stripping
  const applyStripping = (text: string): string => {
    let result = text;
    if (isAssistant) {
      // Assistant messages: strip thinking tags AND relevant-memories blocks
      result = stripThinkingTags(result);
      result = stripRelevantMemoriesBlocks(result);
    } else if (shouldStripInboundMetadata) {
      // User messages: strip inbound metadata and envelope
      result = stripInboundMetadata(stripEnvelope(result));
    } else {
      // Other roles (system, etc.): just strip envelope
      result = stripEnvelope(result);
    }
    // Strip internal system events from all messages
    result = stripInternalSystemEvents(result);
    return result;
  };

  const content = m.content;
  if (typeof content === "string") {
    return applyStripping(content);
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
      return applyStripping(joined);
    }
  }
  if (typeof m.text === "string") {
    return applyStripping(m.text);
  }
  return null;
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
