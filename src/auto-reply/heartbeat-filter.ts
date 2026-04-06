import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "./heartbeat.js";
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
 * Check if a user message looks like a system-generated heartbeat prompt.
 *
 * Heartbeat prompts instruct the model to "reply HEARTBEAT_OK" when nothing
 * needs attention.  To avoid false positives on normal conversation turns
 * that merely quote or discuss the token (e.g. debugging heartbeat behaviour),
 * we require the instruction phrase pattern — not just the bare token.
 */
export function isHeartbeatUserMessage(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "user") {
    return false;
  }
  const text = extractMessageText(message.content);
  // Heartbeat prompts instruct the model with a verb + HEARTBEAT_OK pattern.
  // A plain mention of "HEARTBEAT_OK" in normal conversation (e.g. "what does
  // HEARTBEAT_OK mean?") won't match.  We accept common instruction verbs to
  // cover default, task-based, and custom heartbeat prompts.
  return (
    text.includes(HEARTBEAT_TOKEN) &&
    /(?:reply|respond|return|say|output|answer)\s+(?:with\s+)?HEARTBEAT_OK/i.test(text)
  );
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
 * Matches responses that are purely the HEARTBEAT_OK token — possibly
 * wrapped in markup, preceded by a responsePrefix, or followed by
 * lightweight suffixes (emoji, punctuation) that don't carry real content.
 * This mirrors the detection logic in heartbeat-events-filter.ts.
 *
 * Responses with additional real content are preserved.
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
  if (!normalized.includes(HEARTBEAT_TOKEN)) {
    return false;
  }

  // Strip the HEARTBEAT_OK token and check if only lightweight noise remains.
  // Handles: "HEARTBEAT_OK", "Nex HEARTBEAT_OK", "HEARTBEAT_OK 👍",
  //          "**HEARTBEAT_OK**", responsePrefix + token, etc.
  const tokenIdx = normalized.indexOf(HEARTBEAT_TOKEN);
  const before = normalized.slice(0, tokenIdx).trim();
  const after = normalized.slice(tokenIdx + HEARTBEAT_TOKEN.length).trim();

  // Content before the token must be empty or a short prefix (responsePrefix
  // is typically just the agent name — a single word).
  if (before && before.split(/\s+/).length > 2) {
    return false;
  }

  // Content after the token is allowed up to DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  // matching the suppression logic in heartbeat.ts (stripHeartbeatToken).
  // Short suffixes like "all good" or "👍" are treated as ack noise.
  // Anything longer is real content worth preserving.
  if (after.length > DEFAULT_HEARTBEAT_ACK_MAX_CHARS) {
    return false;
  }

  return true;
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
