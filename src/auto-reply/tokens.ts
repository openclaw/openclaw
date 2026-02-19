import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Returns true if `text` (trimmed) is a prefix of the given silent reply token.
 * Used during streaming to suppress partial tokens like "NO_R", "HEARTBEAT" etc.
 * before the full token has been received.
 */
export function isSilentReplyPrefix(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return token.startsWith(trimmed);
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  const prefix = new RegExp(`^\\s*${escaped}(?=$|\\W)`);
  if (prefix.test(text)) {
    return true;
  }
  const suffix = new RegExp(`\\b${escaped}\\b\\W*$`);
  return suffix.test(text);
}
