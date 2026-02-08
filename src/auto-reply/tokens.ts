export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if text is a silent reply (only contains the token with optional whitespace/punctuation).
 *
 * The previous implementation used `\W*$` to allow trailing non-word characters,
 * but in JavaScript regex `\W` matches any non-ASCII character including CJK.
 * This caused false positives for messages like "测试 NO_REPLY 内容" because
 * Chinese characters were treated as "ignorable trailing characters".
 *
 * The fix uses Unicode property escapes (`\p{P}` for punctuation) to only allow
 * actual punctuation around the token, not letters/numbers/CJK characters.
 */
export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  // Only match if the entire message is the token, optionally surrounded by whitespace/punctuation
  const pattern = new RegExp(`^[\\s\\p{P}]*${escaped}[\\s\\p{P}]*$`, "u");
  return pattern.test(text);
}
