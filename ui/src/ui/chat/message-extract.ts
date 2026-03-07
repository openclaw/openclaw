import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { stripThinkingTags } from "../format.ts";

interface PluginMemoryContext {
  prependTag: string;
  stripRegex: string;
}

interface LancedbPluginMemoryContext {
  lancedb?: PluginMemoryContext;
  core?: PluginMemoryContext;
  qmd?: PluginMemoryContext;
  [key: string]: PluginMemoryContext | undefined;
}

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

/**
 * Strip plugin-injected memory context from user messages.
 * Checks for any field starting with "lancedbPlugin" for extensibility.
 * Each plugin (lancedb, core, qmd, etc.) provides its own stripRegex.
 */
function stripPluginMemoryContext(text: string, message: Record<string, unknown>): string {
  let result = text;

  // Check all fields starting with "lancedbPlugin" for memory context
  for (const key of Object.keys(message)) {
    if (key.startsWith("lancedbPlugin") && key.endsWith("MemoryContext")) {
      const pluginContexts = message[key] as LancedbPluginMemoryContext | undefined;
      if (pluginContexts) {
        // Iterate through each plugin's context (lancedb, core, qmd, etc.)
        for (const ctx of Object.values(pluginContexts)) {
          if (ctx?.stripRegex) {
            try {
              const regex = new RegExp(ctx.stripRegex, "i");
              result = result.replace(regex, "").trim();
            } catch (e) {
              // Invalid regex, skip
            }
          }
        }
      }
    }
  }

  return result;
}

function processMessageText(text: string, role: string, message: Record<string, unknown>): string {
  if (role.toLowerCase() === "assistant") {
    return stripThinkingTags(text);
  }

  const isUser = role.toLowerCase() === "user";
  if (!isUser) {
    return stripEnvelope(text);
  }

  // Strip inbound metadata (channel info, etc.)
  let result = stripInboundMetadata(stripEnvelope(text));

  // Strip any plugin-injected memory context
  result = stripPluginMemoryContext(result, message);

  return result;
}

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const raw = extractRawText(message);
  if (!raw) {
    return null;
  }
  return processMessageText(raw, role, m);
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
