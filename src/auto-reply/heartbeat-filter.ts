import { stripHeartbeatToken } from "./heartbeat.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (typeof block !== "object" || block === null || !("type" in block)) {
        hasNonTextContent = true;
        return false;
      }
      if (block.type !== "text") {
        hasNonTextContent = true;
        return false;
      }
      if (typeof (block as { text?: unknown }).text !== "string") {
        hasNonTextContent = true;
        return false;
      }
      return true;
    })
    .map((block) => block.text)
    .join("");
  return { text, hasNonTextContent };
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
  const { text } = resolveMessageText(message.content);
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
 * Check if an assistant message is effectively a HEARTBEAT_OK response
 * (no actionable content beyond the token itself).
 *
 * Reuse the runtime heartbeat suppression rule so prompt filtering and
 * compaction deletion make the same keep/remove decision as heartbeat send.
 */
export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip;
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
  ackMaxChars?: number,
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
      isHeartbeatOkResponse(messages[i + 1], ackMaxChars)
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
