import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents
  // substantive replies ending with NO_REPLY from being suppressed (#19537).
  return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}

/**
 * Strips a trailing silent-reply token from a substantive message.
 *
 * When an LLM appends NO_REPLY to real content (e.g. "Done.\n\nNO_REPLY"),
 * the message should be delivered without the token rather than suppressed.
 * This handles that case while leaving exact-NO_REPLY messages untouched
 * (those are caught by isSilentReplyText and suppressed normally).
 */
export function stripTrailingSilentReplyToken(
  text: string,
  token: string = SILENT_REPLY_TOKEN,
): { text: string; didStrip: boolean } {
  const escaped = escapeRegExp(token);
  const trailingPattern = new RegExp(`\\s*\\n\\s*${escaped}\\s*$`);
  if (trailingPattern.test(text)) {
    return { text: text.replace(trailingPattern, "").trimEnd(), didStrip: true };
  }
  return { text, didStrip: false };
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trimStart().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("_")) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  return token.toUpperCase().startsWith(normalized);
}
