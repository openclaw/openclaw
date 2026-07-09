// Chat send input sanitizer for Gateway message payloads.

/** Regex matching ASCII control characters that must be stripped from user messages.
 *  Preserves: \t (\x09), \n (\x0A), \r (\x0D). */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CHAT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Drop disallowed control characters while preserving tab and line breaks. */
function stripDisallowedChatControlChars(message: string): string {
  return message.replace(DISALLOWED_CHAT_CONTROL_RE, "");
}

/** Normalize chat text and reject null bytes before routing to channels. */
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}
