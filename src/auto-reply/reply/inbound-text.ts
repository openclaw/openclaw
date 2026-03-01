export function normalizeInboundTextNewlines(input: string): string {
  // Normalize actual newline characters (CR+LF and CR to LF).
  // Do NOT replace literal backslash-n sequences (\\n) as they may be part of
  // Windows paths like C:\Work\nxxx\README.md or user-intended escape sequences.
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Patterns that mimic internal context markers used by OpenClaw.
 *
 * These bracketed prefixes (`[System Message]`, `[System]`, `[Assistant]`) are
 * used internally to inject system-level context into agent transcripts (e.g.
 * sub-agent announcements).  An attacker can send these strings through an
 * inbound channel (WhatsApp, Telegram, …) to trick the LLM into treating
 * user-supplied text as trusted system context.
 *
 * Neutralization replaces the square brackets with parentheses so the text is
 * still human-readable but no longer matches the internal marker format.
 *
 * See: https://github.com/MunemHashmi/openclaw/issues/30111
 */
const SYSTEM_TAG_PATTERN = /\[\s*(System\s*Message|System|Assistant|Internal)\s*\]/gi;

/**
 * Neutralize bracketed system-tag patterns in inbound message bodies.
 *
 * Replaces `[System Message]` → `(System Message)` etc., preventing prompt
 * injection via fake internal context markers from untrusted channel input.
 */
export function sanitizeInboundSystemTags(input: string): string {
  return input.replace(SYSTEM_TAG_PATTERN, (_match, tag: string) => `(${tag})`);
}
