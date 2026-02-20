import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { stripThinkingTags } from "../format.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();
const INBOUND_METADATA_START_LINES = new Set<string>([
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
]);

function stripInboundMetadataPrefix(text: string): string {
  if (!text.includes("untrusted metadata") && !text.includes("untrusted, for context")) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = typeof rawLine === "string" ? rawLine.trim() : "";

    if (!line) {
      index++;
      continue;
    }

    if (!INBOUND_METADATA_START_LINES.has(line)) {
      break;
    }

    // Expected shape:
    // <Header>
    // ```json
    // ...
    // ```
    const fenceLine = lines[index + 1];
    if (typeof fenceLine !== "string" || fenceLine.trim() !== "```json") {
      break;
    }

    let closeFenceIndex = index + 2;
    while (closeFenceIndex < lines.length && lines[closeFenceIndex]?.trim() !== "```") {
      closeFenceIndex++;
    }
    if (closeFenceIndex >= lines.length) {
      break;
    }

    index = closeFenceIndex + 1;
    while (index < lines.length && lines[index].trim() === "") {
      index++;
    }
  }

  if (index >= lines.length) {
    return "";
  }

  return lines.slice(index).join("\n");
}

export { stripInboundMetadataPrefix };

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  if (typeof content === "string") {
    const processed =
      role === "assistant"
        ? stripThinkingTags(content)
        : stripInboundMetadataPrefix(stripEnvelope(content));
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
          : stripInboundMetadataPrefix(stripEnvelope(joined));
      return processed;
    }
  }
  if (typeof m.text === "string") {
    const processed =
      role === "assistant"
        ? stripThinkingTags(m.text)
        : stripInboundMetadataPrefix(stripEnvelope(m.text));
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
