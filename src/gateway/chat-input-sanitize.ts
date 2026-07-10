// Chat send input sanitizer for Gateway message payloads.

// Disallowed control characters: C0 controls (U+0001–U+001F) except TAB (U+0009),
// LF (U+000A), and CR (U+000D), plus DEL (U+007F). Null (U+0000) is intentionally
// excluded here — it is rejected outright by sanitizeChatSendMessageInput rather than
// silently stripped. Everything else — printable text and code points >= U+0080 — is
// preserved. Built from char codes so the source carries no literal control bytes.
// A single native regex pass replaces the previous per-character rebuild, whose
// repeated string concatenation degraded to quadratic time and blocked the event loop
// on large (multi-MB) messages (issue #102915).
const DISALLOWED_CHAT_CONTROL_CHARS = buildDisallowedControlCharRegex();
const NULL_BYTE = String.fromCharCode(0);

function buildDisallowedControlCharRegex(): RegExp {
  const codes: number[] = [];
  for (let code = 0x01; code <= 0x1f; code++) {
    if (code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      codes.push(code);
    }
  }
  codes.push(0x7f);
  const charClass = codes.map((code) => String.fromCharCode(code)).join("");
  return new RegExp(`[${charClass}]`, "g");
}

/** Drop disallowed control characters while preserving tab and line breaks. */
function stripDisallowedChatControlChars(message: string): string {
  return message.replace(DISALLOWED_CHAT_CONTROL_CHARS, "");
}

/** Normalize chat text and reject null bytes before routing to channels. */
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes(NULL_BYTE)) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}
