/**
 * Message normalization utilities for chat rendering.
 */

import type {
  NormalizedMessage,
  MessageContentItem,
} from "../types/chat-types";

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === "string" ? m.role : "unknown";

  // Detect tool result messages by presence of toolCallId or tool_call_id
  if (typeof m.toolCallId === "string" || typeof m.tool_call_id === "string") {
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
 * Tool results should be grouped with assistant messages.
 */
export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  // All tool-related roles should display as assistant
  if (
    lower === "toolresult" ||
    lower === "tool_result" ||
    lower === "tool" ||
    lower === "function"
  ) {
    return "assistant";
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
