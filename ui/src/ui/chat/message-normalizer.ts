/**
 * Message normalization utilities for chat rendering.
 */

import type { NormalizedMessage, MessageContentItem } from "../types/chat-types.ts";

/**
 * Strip injected memory context from user messages.
 * Memory plugins prepend `<relevant-memories>...</relevant-memories>` blocks
 * to user prompts for AI context, but these should be hidden from the UI.
 */
function stripInjectedMemoryContext(text: string): string {
  // Remove <relevant-memories>...</relevant-memories> blocks (including newlines after)
  return text.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
}

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

  // Only strip injected memory context from user messages (where it's prepended)
  const shouldStripMemory = role === "user";

  if (typeof m.content === "string") {
    const text = shouldStripMemory ? stripInjectedMemoryContext(m.content) : m.content;
    content = [{ type: "text", text }];
  } else if (Array.isArray(m.content)) {
    content = m.content.map((item: Record<string, unknown>) => {
      let text = item.text as string | undefined;
      if (shouldStripMemory && typeof text === "string") {
        text = stripInjectedMemoryContext(text);
      }
      return {
        type: (item.type as MessageContentItem["type"]) || "text",
        text,
        name: item.name as string | undefined,
        args: item.args || item.arguments,
      };
    });
  } else if (typeof m.text === "string") {
    const text = shouldStripMemory ? stripInjectedMemoryContext(m.text) : m.text;
    content = [{ type: "text", text }];
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
