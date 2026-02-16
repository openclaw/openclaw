/**
 * Message normalization utilities for chat rendering.
 */

import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import type { NormalizedMessage, MessageContentItem } from "../types/chat-types.ts";

// Keep in sync with src/auto-reply/tokens.ts.
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

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

  // Strip AI-injected metadata prefix blocks from user messages before display.
  if (role === "user" || role === "User") {
    content = content.map((item) => {
      if (item.type === "text" && typeof item.text === "string") {
        return { ...item, text: stripInboundMetadata(item.text) };
      }
      return item;
    });
  }

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
 * Pattern matching the HEARTBEAT_OK token with optional surrounding
 * whitespace and short emoji/punctuation (up to 8 extra characters).
 */
const HEARTBEAT_PATTERN = new RegExp(
  `^\\s*${HEARTBEAT_TOKEN}[\\s\\p{Extended_Pictographic}\\uFE0F]{0,8}$`,
  "u",
);

/**
 * Check if a message contains only heartbeat acknowledgment content.
 * Heartbeat messages are automated health-check responses that contain
 * "HEARTBEAT_OK" and optionally a small amount of whitespace or emoji.
 * These are not useful to display to end users in the chat thread.
 */
export function isHeartbeatMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;

  // Check direct text field
  if (typeof m.text === "string" && HEARTBEAT_PATTERN.test(m.text)) {
    return true;
  }

  // Check string content
  if (typeof m.content === "string" && HEARTBEAT_PATTERN.test(m.content)) {
    return true;
  }

  // Check content array — all text items must be heartbeat-only
  if (Array.isArray(m.content)) {
    const textItems = m.content.filter((item: unknown) => {
      if (item == null || typeof item !== "object") {
        return false;
      }
      const o = item as Record<string, unknown>;
      return (o.type === "text" || o.type === undefined) && typeof o.text === "string";
    });
    if (
      textItems.length > 0 &&
      textItems.every((item: Record<string, unknown>) =>
        HEARTBEAT_PATTERN.test(item.text as string),
      )
    ) {
      return true;
    }
  }

  return false;
}
