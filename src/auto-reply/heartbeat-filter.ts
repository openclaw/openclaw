import { HEARTBEAT_TOKEN } from "./tokens.js";

/**
 * Extract text content from a message's content field.
 * Handles both string content and content block arrays.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Check if a user message looks like a heartbeat prompt.
 * Heartbeat prompts instruct the model to "reply HEARTBEAT_OK" when nothing
 * needs attention — this pattern is present in all heartbeat prompt variants
 * (default, task-based, custom).
 */
export function isHeartbeatUserMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") {
    return false;
  }
  const text = extractMessageText(message.content);
  return text.includes(HEARTBEAT_TOKEN);
}

/**
 * Strip lightweight markup (HTML tags, markdown bold/italic/code wrappers)
 * so "**HEARTBEAT_OK**" normalizes to "HEARTBEAT_OK".
 */
function stripMarkup(text: string): string {
  return (
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .trim()
      // Strip leading/trailing markdown wrappers
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "")
      .trim()
  );
}

/**
 * Check if an assistant message is effectively a HEARTBEAT_OK response
 * (no actionable content beyond the token itself).
 *
 * Only matches responses that are purely the HEARTBEAT_OK token, possibly
 * wrapped in markup. Responses with additional real content are preserved.
 */
export function isHeartbeatOkResponse(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const text = extractMessageText(message.content);
  if (!text) {
    return false;
  }
  const normalized = stripMarkup(text);
  // Match only when the entire response (after normalizing markup) is just the token
  return normalized === HEARTBEAT_TOKEN;
}

/**
 * Filter out heartbeat user+assistant pairs from a message array.
 *
 * Only removes pairs where:
 * 1. The user message matches the heartbeat prompt pattern (contains HEARTBEAT_OK instruction)
 * 2. The immediately following assistant message is effectively HEARTBEAT_OK (no real content)
 *
 * Heartbeat turns that produced actual content (calendar reminders, email alerts, etc.)
 * are preserved because their assistant response won't match the HEARTBEAT_OK pattern.
 */
export function filterHeartbeatPairs<T extends { role: string; content?: unknown }>(
  messages: T[],
): T[] {
  if (messages.length < 2) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    // Check for heartbeat user+assistant pair
    if (
      i + 1 < messages.length &&
      isHeartbeatUserMessage(messages[i]) &&
      isHeartbeatOkResponse(messages[i + 1])
    ) {
      // Skip both the user message and the HEARTBEAT_OK response
      i += 2;
      continue;
    }
    result.push(messages[i]);
    i++;
  }

  return result;
}
