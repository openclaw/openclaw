/**
 * Message normalization utilities for chat rendering.
 */

import type { NormalizedMessage, MessageContentItem } from "../types/chat-types.ts";

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === "string" ? m.role : "unknown";

  // Detect tool messages by common gateway shapes.
  // Some tool events come through as assistant role with tool_* items in the content array.
  const hasToolId = typeof m.toolCallId === "string" || typeof m.tool_call_id === "string";

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    Array.isArray(contentItems) &&
    contentItems.some((item) => {
      const x = item as Record<string, unknown>;
      const t = (typeof x.type === "string" ? x.type : "").toLowerCase();
      return t === "toolresult" || t === "tool_result";
    });

  const hasToolName = typeof m.toolName === "string" || typeof m.tool_name === "string";

  if (hasToolId || hasToolContent || hasToolName) {
    role = "toolResult";
  }

  // Extract content
  let content: MessageContentItem[] = [];

  if (typeof m.content === "string") {
    content = [{ type: "text", text: m.content }];
  } else if (Array.isArray(m.content)) {
    content = m.content.map((item: Record<string, unknown>) => ({
      type: (item.type as MessageContentItem["type"]) || "text",
      text: item.text as string | undefined,
      name: item.name as string | undefined,
      args: item.args || item.arguments,
    }));
  } else if (typeof m.text === "string") {
    content = [{ type: "text", text: m.text }];
  }

  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const id = typeof m.id === "string" ? m.id : undefined;

  return { role, content, timestamp, id };
}

/**
 * Normalize role for grouping purposes.
 */
export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  // Preserve original casing when it's already a core role.
  if (role === "user" || role === "User") {
    return role;
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "system") {
    return "system";
  }
  // Keep tool-related roles distinct so the UI can style/toggle them.
  if (
    lower === "toolresult" ||
    lower === "tool_result" ||
    lower === "tool" ||
    lower === "function"
  ) {
    return "tool";
  }
  return role;
}

/**
 * Check if a message is a tool result message based on its role.
 */
export function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}

/**
 * Internal system message patterns that should be hidden from WebChat UI.
 * These are housekeeping messages injected by the Gateway for internal operations.
 */
const INTERNAL_MESSAGE_PATTERNS = [
  // Memory flush prompts (compaction)
  /Pre-compaction memory flush/i,
  // Session reset/new greeting prompts
  /A new session was started via \/new or \/reset/i,
];

/**
 * Silent reply token pattern - messages starting with NO_REPLY are internal responses.
 */
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY(?:$|\W)/;

/**
 * Extract text content from a message for pattern matching.
 */
function extractMessageText(message: unknown): string {
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string") {
    return m.content;
  }
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const item of m.content) {
      if (item && typeof item === "object") {
        const rec = item as { type?: unknown; text?: unknown };
        if (rec.type === "text" && typeof rec.text === "string") {
          parts.push(rec.text);
        }
      }
    }
    return parts.join("\n");
  }
  if (typeof m.text === "string") {
    return m.text;
  }
  return "";
}

/**
 * Check if a message is an internal system message that should be hidden from the UI.
 * This includes:
 * - Memory flush prompts (pre-compaction)
 * - Session reset/new greeting prompts
 * - Silent reply messages (NO_REPLY responses)
 */
export function isInternalSystemMessage(message: unknown): boolean {
  const text = extractMessageText(message);
  if (!text) {
    return false;
  }

  // Check for silent reply token (agent's internal response)
  if (SILENT_REPLY_PATTERN.test(text)) {
    return true;
  }

  // Check for internal system message patterns
  for (const pattern of INTERNAL_MESSAGE_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}
