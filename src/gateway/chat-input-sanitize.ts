// Chat send input sanitizer for Gateway message payloads.

// Control characters to strip: NUL–BS (0–8), VT (11), FF (12), SO–US (14–31), DEL (127).
// Tab (9), LF (10), CR (13), printable ASCII (32–126), and Unicode (128+) are kept.
// eslint-disable-next-line no-control-regex
const DISALLOWED_CHAT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Drop disallowed control characters while preserving tab, line breaks, and Unicode. */
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
