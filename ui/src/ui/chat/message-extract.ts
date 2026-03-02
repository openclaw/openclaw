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

  // Back-compat: older logs or streaming may have <think> tags inside text blocks.
  const rawText = extractRawText(message);
  if (!rawText) {
    return null;
  }

  const thinkingRegex =
    /(?:<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>|\[\[reply_to_current\]\]|\n?think\s*>|\[\(\s*(?:deep_)?think\s*\)\])([\s\S]*?)(?:<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>|\[\[reply_to_current\]\]|\[\(\s*\/\s*(?:deep_)?think\s*\)\]|$)/gi;
  const matches = [...rawText.matchAll(thinkingRegex)];
  const extracted = matches.map((m) => (m[1] ?? "").trim()).filter(Boolean);

  if (extracted.length === 0 && rawText.includes("[[reply_to_current]]")) {
    const [thought] = rawText.split(/\[\[reply_to_current\]\]/i);
    if (thought.trim()) {
      extracted.push(thought.trim());
    }
  }

  if (extracted.length > 0) {
    return extracted.join("\n");
  }

  // Handle <final> or other potential markers if needed, but <think> is primary.
  return null;
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
