/**
 * Inbound user directive detection and stripping.
 *
 * Handles user-facing directives that affect outbound behavior without
 * requiring LLM cooperation (e.g., "reply in thread" triggers).
 */

/**
 * Default trigger phrases for the reply-in-thread directive.
 * Case-insensitive, matched at the end of the message.
 */
const DEFAULT_REPLY_IN_THREAD_TRIGGERS = [
  "reply in thread",
  "rit",
  "thread",
  "in thread",
] as const;

/**
 * Regex pattern for detecting reply-in-thread triggers at the end of a message.
 * Matches trigger phrases preceded by whitespace (to avoid stripping punctuation from message).
 * Allows optional trailing punctuation and whitespace.
 * Note: Not using global flag to get match.index for position information.
 */
const REPLY_IN_THREAD_RE = new RegExp(
  `\\s+(${DEFAULT_REPLY_IN_THREAD_TRIGGERS.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})[\\s\\p{P}]*$`,
  "iu",
);

export type InboundUserDirectiveResult = {
  /** The message text with trigger phrases stripped. */
  cleaned: string;
  /** True if a reply-in-thread trigger was detected and stripped. */
  replyInThread: boolean;
};

/**
 * Detects and strips inbound user directives from message text.
 *
 * Currently handles:
 * - "reply in thread" / "rit" / "thread" / "in thread" at end of message
 *
 * @param text - The message text to process
 * @returns The cleaned text and detected directive flags
 */
export function extractInboundUserDirectives(text: string): InboundUserDirectiveResult {
  if (!text || !text.trim()) {
    return { cleaned: text ?? "", replyInThread: false };
  }

  let replyInThread = false;
  let cleaned = text;

  // Detect reply-in-thread trigger at end of message
  const match = cleaned.match(REPLY_IN_THREAD_RE);
  if (match) {
    replyInThread = true;
    cleaned = cleaned.slice(0, match.index).trim();
  }

  return { cleaned, replyInThread };
}

/**
 * Checks if the given text contains a reply-in-thread trigger.
 * Does not modify the text.
 *
 * @param text - The message text to check
 * @returns True if a reply-in-thread trigger is present
 */
export function hasReplyInThreadDirective(text: string): boolean {
  if (!text || !text.trim()) {
    return false;
  }
  return REPLY_IN_THREAD_RE.test(text);
}
