import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";

export type ToolCallIdMode = "strict" | "strict9";

const STRICT9_LEN = 9;

/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (!id || typeof id !== "string") {
    if (mode === "strict9") {
      return "defaultid";
    }
    return "defaulttoolid";
  }

  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, STRICT9_LEN);
    }
    return shortHash("sanitized", STRICT9_LEN);
  }

  // Some providers require strictly alphanumeric tool call IDs.
  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}

export function isValidCloudCodeAssistToolId(id: string, mode: ToolCallIdMode = "strict"): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  if (mode === "strict9") {
    return /^[a-zA-Z0-9]{9}$/.test(id);
  }
  // Strictly alphanumeric for providers with tighter tool ID constraints
  return /^[a-zA-Z0-9]+$/.test(id);
}

function shortHash(text: string, length = 8): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}

function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  if (params.mode === "strict9") {
    const base = sanitizeToolCallId(params.id, params.mode);
    const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
    if (candidate && !params.used.has(candidate)) {
      return candidate;
    }

    for (let i = 0; i < 1000; i += 1) {
      const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
      if (!params.used.has(hashed)) {
        return hashed;
      }
    }

    return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
  }

  const MAX_LEN = 40;

  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) {
    return base;
  }

  const hash = shortHash(params.id);
  // Use separator based on mode: none for strict, underscore for non-strict variants
  const separator = params.mode === "strict" ? "" : "_";
  const maxBaseLen = MAX_LEN - separator.length - hash.length;
  const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  const candidate = `${clippedBase}${separator}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  resolve: (id: string) => string;
}): Extract<AgentMessage, { role: "assistant" }> {
  const content = params.message.content;
  if (!Array.isArray(content)) {
    return params.message;
  }

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
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
    if (nextId === id) {
      return block;
    }
    changed = true;
    return { ...(block as unknown as Record<string, unknown>), id: nextId };
  });

  if (!changed) {
    return params.message;
  }
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
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 */

/**
 * Check if a value is a plain object (not a class instance like Date, Map, etc.).
 * Tool call arguments are JSON-serialized, so we only expect plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively removes properties with null or undefined values from an object.
 * Returns both the cleaned value and whether any changes were made.
 *
 * This is needed because some LLMs (like DeepSeek, Llama) send explicit null values
 * for optional parameters, but TypeBox/AJV schemas expect them to be omitted.
 *
 * Note: Only recurses into plain objects (not class instances like Date, Map, etc.)
 * since tool call arguments are JSON-only by design.
 */
function removeNullProperties<T>(obj: T): { value: T; changed: boolean } {
  if (obj === null || obj === undefined) {
    return { value: obj, changed: false };
  }

  if (Array.isArray(obj)) {
    let arrayChanged = false;
    const mapped = obj.map((item) => {
      const result = removeNullProperties(item);
      if (result.changed) {
        arrayChanged = true;
      }
      return result.value;
    });
    return { value: (arrayChanged ? mapped : obj) as T, changed: arrayChanged };
  }

  if (isPlainObject(obj)) {
    let objectChanged = false;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        objectChanged = true;
        // Skip null/undefined properties
      } else {
        const cleaned = removeNullProperties(value);
        if (cleaned.changed) {
          objectChanged = true;
        }
        result[key] = cleaned.value;
      }
    }
    return { value: (objectChanged ? result : obj) as T, changed: objectChanged };
  }

  // Non-plain objects (Date, Map, etc.) and primitives pass through unchanged
  return { value: obj, changed: false };
}

/**
 * Normalize tool call arguments in assistant messages.
 *
 * This function handles two cases:
 * 1. Existing null/undefined arguments field -> converts to empty object {}
 * 2. Arguments containing null-valued properties -> removes those properties
 *
 * Note: Missing arguments fields are left as-is (not synthesized).
 *
 * Some LLMs like DeepSeek and Llama send explicit null values for optional
 * parameters (e.g., { "command": "ls", "optional_param": null }), but TypeBox/AJV
 * schemas expect optional parameters to be omitted, not null.
 *
 * @param messages - The messages to normalize
 * @returns The normalized messages (same reference if no changes needed)
 */
export function normalizeToolCallArguments(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;

  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      return msg;
    }

    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return msg;
    }

    let contentChanged = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const rec = block as { type?: unknown; arguments?: unknown; args?: unknown };
      const type = rec.type;

      // Check if this is a tool call block
      if (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") {
        return block;
      }

      // Get the arguments field (could be "arguments" or "args")
      // Only process if the field exists - don't add it if missing
      const argsKey = "arguments" in rec ? "arguments" : "args" in rec ? "args" : null;
      if (!argsKey) {
        // No arguments field at all - leave as-is (don't synthesize)
        return block;
      }

      const args = rec[argsKey as keyof typeof rec];

      // If arguments is explicitly null/undefined (but field exists), replace with empty object
      if (args === null || args === undefined) {
        contentChanged = true;
        return { ...(block as Record<string, unknown>), [argsKey]: {} };
      }

      // If arguments is an object, remove null-valued properties
      if (typeof args === "object" && !Array.isArray(args)) {
        const { value: cleaned, changed: argsChanged } = removeNullProperties(args);
        if (argsChanged) {
          contentChanged = true;
          return { ...(block as Record<string, unknown>), [argsKey]: cleaned };
        }
      }

      return block;
    });

    if (!contentChanged) {
      return msg;
    }
    changed = true;
    return { ...msg, content: nextContent } as AgentMessage;
  });

  return changed ? out : messages;
}

export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
): AgentMessage[] {
  // Strict mode: only [a-zA-Z0-9]
  // Strict9 mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
  // Sanitization can introduce collisions (e.g. `a|b` and `a:b` -> `ab`).
  // Fix by applying a stable, transcript-wide mapping and de-duping via suffix.
  const map = new Map<string, string>();
  const used = new Set<string>();

  const resolve = (id: string) => {
    const existing = map.get(id);
    if (existing) {
      return existing;
    }
    const next = makeUniqueToolId({ id, used, mode });
    map.set(id, next);
    used.add(next);
    return next;
  };

  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const next = rewriteAssistantToolCallIds({
        message: msg as Extract<AgentMessage, { role: "assistant" }>,
        resolve,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    if (role === "toolResult") {
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolve,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    return msg;
  });

  return changed ? out : messages;
}
