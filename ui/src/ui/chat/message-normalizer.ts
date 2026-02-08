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
 * Tool-related content type names (both call and result sides).
 */
const TOOL_CONTENT_TYPES = new Set([
  "toolcall",
  "tool_call",
  "tooluse",
  "tool_use",
  "toolresult",
  "tool_result",
]);

/**
 * Check if a message is purely tool-related (contains only tool call/result
 * content items with no meaningful text).  Used to hide tool blocks when
 * the "show thinking/working" toggle is off.
 */
export function isToolOnlyMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;

  // Messages already classified as tool results.
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  if (role === "toolresult" || role === "tool_result") return true;

  // Messages with a toolCallId are tool-related regardless of role.
  if (typeof m.toolCallId === "string" || typeof m.tool_call_id === "string") return true;

  const contentRaw = m.content;
  if (!Array.isArray(contentRaw) || contentRaw.length === 0) return false;

  // Check every content item — if all are tool types (and none have meaningful text), it's tool-only.
  for (const item of contentRaw) {
    const x = item as Record<string, unknown>;
    const t = (typeof x.type === "string" ? x.type : "").toLowerCase();

    if (TOOL_CONTENT_TYPES.has(t)) continue;

    // A "thinking" block isn't user-visible text either.
    if (t === "thinking") continue;

    // Text items with actual content mean this isn't tool-only.
    if (t === "text" || t === "") {
      const text = typeof x.text === "string" ? x.text.trim() : "";
      if (text) return false;
      continue; // empty text items are fine
    }

    // Image or other content types — not tool-only.
    return false;
  }

  return true;
}
