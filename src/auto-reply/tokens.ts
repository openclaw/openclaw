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

/**
 * Strips the silent reply token (NO_REPLY) from the end of a message text.
 * This handles cases where LLMs append NO_REPLY to actual content instead of
 * using it as the entire message. (#30916)
 *
 * @param text - The message text to process
 * @param token - The silent reply token to strip (default: "NO_REPLY")
 * @returns The text with trailing NO_REPLY removed, or the original text if not found
 */
export function stripSilentReplyToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): string {
  if (!text) {
    return "";
  }
  const escaped = escapeRegExp(token);
  // Match NO_REPLY at the end of the message, optionally preceded by whitespace/newlines
  // This pattern handles cases like:
  // "Some message.\n\nNO_REPLY" -> "Some message."
  // "Some message. NO_REPLY" -> "Some message."
  // "Some message. NO_REPLY\n" -> "Some message."
  const pattern = new RegExp(`[\\s]*${escaped}[\\s]*$`, "i");
  return text.replace(pattern, "").trimEnd();
}
