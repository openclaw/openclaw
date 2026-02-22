/**
 * Message normalization utilities for chat rendering.
 */

import { stripInboundMetadata } from "../../../../src/auto-reply/reply/strip-inbound-meta.js";
import type {
  ChatOrigin,
  NormalizedMessage,
  MessageContentItem,
} from "../types/chat-types.ts";

export type { ChatOrigin };

export function getMessageOrigin(message: unknown): ChatOrigin | undefined {
  const m = message as Record<string, unknown>;
  const openclaw = m?.__openclaw as Record<string, unknown> | undefined;
  const origin = openclaw?.origin;
  if (origin === "human" || origin === "mainAgent" || origin === "subAgent") {
    return origin;
  }
  return undefined;
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

  const origin = getMessageOrigin(message);
  return { role, content, timestamp, id, origin };
}

/**
 * Normalize role for grouping purposes. When origin is mainAgent/subAgent,
 * returns a composite key so assistant messages split by origin (issue #22774).
 */
export function normalizeRoleForGrouping(role: string, origin?: ChatOrigin): string {
  const lower = role.toLowerCase();
  // Preserve original casing when it's already a core role.
  if (role === "user" || role === "User") {
    return role;
  }
  if (role === "assistant") {
    if (origin === "mainAgent" || origin === "subAgent") {
      return `assistant:${origin}`;
    }
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

/** Base role for CSS classes (e.g. "assistant:mainAgent" -> "assistant"). */
export function baseRoleForGroup(groupRole: string): string {
  const i = groupRole.indexOf(":");
  return i >= 0 ? groupRole.slice(0, i) : groupRole;
}

/**
 * Check if a message is a tool result message based on its role.
 */
export function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}
