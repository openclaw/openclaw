import { createHash } from "node:crypto";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type ToolCallIdMode = "standard" | "strict";

/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "standard" mode: allows [a-zA-Z0-9_-], better readability (default)
 * - "strict" mode: only [a-zA-Z0-9], required for Mistral via OpenRouter
 */
export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "standard"): string {
  if (!id || typeof id !== "string") {
    return mode === "strict" ? "defaulttoolid" : "default_tool_id";
  }

  if (mode === "strict") {
    // Some providers (e.g. Mistral via OpenRouter) require strictly alphanumeric tool call IDs.
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
  }

  // Standard mode: allow underscores and hyphens for better readability in logs
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const trimmed = sanitized.replace(/^[^a-zA-Z0-9_-]+/, "");
  return trimmed.length > 0 ? trimmed : "sanitized_tool_id";
}

export function isValidCloudCodeAssistToolId(id: string, mode: ToolCallIdMode = "standard"): boolean {
  if (!id || typeof id !== "string") return false;
  if (mode === "strict") {
    // Strictly alphanumeric for providers like Mistral via OpenRouter
    return /^[a-zA-Z0-9]+$/.test(id);
  }
  // Standard mode allows underscores and hyphens
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function makeUniqueToolId(params: {
  id: string;
  used: Set<string>;
  mode: ToolCallIdMode;
}): string {
  const MAX_LEN = 40;

  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) return base;

  const hash = shortHash(params.id);
  // Use separator based on mode: underscore for standard (readable), none for strict
  const separator = params.mode === "strict" ? "" : "_";
  const maxBaseLen = MAX_LEN - separator.length - hash.length;
  const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  const candidate = `${clippedBase}${separator}${hash}`;
  if (!params.used.has(candidate)) return candidate;

  for (let i = 2; i < 1000; i += 1) {
    const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) return next;
  }

  const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  resolve: (id: string) => string;
}): Extract<AgentMessage, { role: "assistant" }> {
  const content = params.message.content;
  if (!Array.isArray(content)) return params.message;

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const rec = block as { type?: unknown; id?: unknown };
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
      typeof id !== "string" ||
      !id
    ) {
      return block;
    }
    const nextId = params.resolve(id);
    if (nextId === id) return block;
    changed = true;
    return { ...(block as unknown as Record<string, unknown>), id: nextId };
  });

  if (!changed) return params.message;
  return { ...params.message, content: next as typeof params.message.content };
}

function rewriteToolResultIds(params: {
  message: Extract<AgentMessage, { role: "toolResult" }>;
  resolve: (id: string) => string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  const toolCallId =
    typeof params.message.toolCallId === "string" && params.message.toolCallId
      ? params.message.toolCallId
      : undefined;
  const toolUseId = (params.message as { toolUseId?: unknown }).toolUseId;
  const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;

  const nextToolCallId = toolCallId ? params.resolve(toolCallId) : undefined;
  const nextToolUseId = toolUseIdStr ? params.resolve(toolUseIdStr) : undefined;

  if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) {
    return params.message;
  }

  return {
    ...params.message,
    ...(nextToolCallId && { toolCallId: nextToolCallId }),
    ...(nextToolUseId && { toolUseId: nextToolUseId }),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "standard" (default, allows _-) or "strict" (alphanumeric only for Mistral/OpenRouter)
 */
export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "standard",
): AgentMessage[] {
  // Standard mode: allows [a-zA-Z0-9_-] for better readability in session logs
  // Strict mode: only [a-zA-Z0-9] for providers like Mistral via OpenRouter
  // Sanitization can introduce collisions (e.g. `a|b` and `a:b` -> `a_b` or `ab`).
  // Fix by applying a stable, transcript-wide mapping and de-duping via suffix.
  const map = new Map<string, string>();
  const used = new Set<string>();

  const resolve = (id: string) => {
    const existing = map.get(id);
    if (existing) return existing;
    const next = makeUniqueToolId({ id, used, mode });
    map.set(id, next);
    used.add(next);
    return next;
  };

  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const next = rewriteAssistantToolCallIds({
        message: msg as Extract<AgentMessage, { role: "assistant" }>,
        resolve,
      });
      if (next !== msg) changed = true;
      return next;
    }
    if (role === "toolResult") {
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolve,
      });
      if (next !== msg) changed = true;
      return next;
    }
    return msg;
  });

  return changed ? out : messages;
}
