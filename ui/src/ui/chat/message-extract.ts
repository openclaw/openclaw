import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import { stripEnvelope } from "../../../../src/shared/chat-envelope.js";
import { stripRelevantMemoriesTags } from "../../../../src/shared/text/assistant-visible-text.js";
import { stripThinkingTags } from "../format.ts";

const textCache = new WeakMap<object, string | null>();
const thinkingCache = new WeakMap<object, string | null>();

interface DisplayStripPattern {
  regex: string;
  flags?: string;
}

/**
 * Apply display-strip patterns declared by the memory-lancedb plugin.
 * Patterns live under `messageMeta["memory-lancedb"].displayStripPatterns`
 * — a private namespace that only memory-lancedb populates. Other plugins
 * cannot interfere because each plugin's meta is namespaced by its own ID.
 * Falls back to hardcoded stripRelevantMemoriesTags as a safety net.
 */
function stripDisplayPatterns(text: string, message: unknown): string {
  const m = message as Record<string, unknown>;
  const meta = m.messageMeta as Record<string, unknown> | undefined;
  const lancedbMeta = meta?.["memory-lancedb"] as Record<string, unknown> | undefined;
  const patterns = lancedbMeta?.displayStripPatterns as DisplayStripPattern[] | undefined;

  let result = text;
  if (Array.isArray(patterns) && patterns.length > 0) {
    for (const p of patterns) {
      if (typeof p?.regex !== "string") {
        continue;
      }
      try {
        result = result.replace(new RegExp(p.regex, p.flags ?? "gi"), "");
      } catch {
        // skip invalid regex
      }
    }
    // Still run hardcoded fallback after pattern-driven strip: if the
    // plugin-provided regex was malformed or missed a variant format,
    // the safety net catches it.
    return stripRelevantMemoriesTags(result.trimStart());
  }

  // Hardcoded fallback: strip <relevant-memories> tags even when messageMeta
  // is absent (e.g. sessions created before this feature, or chat.history API
  // that doesn't pass messageMeta through).
  return stripRelevantMemoriesTags(result);
}

function processMessageText(text: string, role: string, message?: unknown): string {
  if (role === "assistant") {
    return stripThinkingTags(text);
  }
  const shouldStripInboundMetadata = role.toLowerCase() === "user";
  const stripped = shouldStripInboundMetadata
    ? stripInboundMetadata(stripEnvelope(text))
    : stripEnvelope(text);

  // For user messages, also strip plugin-injected context (e.g. <relevant-memories>)
  // After stripping, re-run stripEnvelope: the prependContext injection may have
  // pushed the envelope timestamp (e.g. "[Sun 2026-03-15 10:30 CST] …") behind
  // the <relevant-memories> block, so the first stripEnvelope pass couldn't see it.
  if (shouldStripInboundMetadata && message) {
    // trimStart() so any leading whitespace left by the memory block removal
    // doesn't prevent stripEnvelope from matching the `[…]` prefix.
    return stripEnvelope(stripDisplayPatterns(stripped, message).trimStart());
  }
  return stripped;
}

export function extractText(message: unknown): string | null {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const raw = extractRawText(message);
  if (!raw) {
    return null;
  }
  return processMessageText(raw, role, message);
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
