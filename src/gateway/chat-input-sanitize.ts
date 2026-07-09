// Chat send input sanitizer for Gateway message payloads.

// Control characters to strip: NUL–BS (0–8), VT (11), FF (12), SO–US (14–31), DEL (127).
// Tab (9), LF (10), CR (13), printable ASCII (32–126), and Unicode (128+) are kept.
// Constructed from code points to satisfy the no-control-regex lint rule.
const DISALLOWED_CHAT_CONTROL_RE = new RegExp(
  "[" +
    String.fromCodePoint(0, 1, 2, 3, 4, 5, 6, 7, 8) +
    String.fromCodePoint(11) +
    String.fromCodePoint(12) +
    String.fromCodePoint(14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31) +
    String.fromCodePoint(127) +
    "]",
  "g",
);

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
