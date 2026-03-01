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
 * Strip a trailing NO_REPLY token from text that contains substantive content.
 * Weaker models sometimes append NO_REPLY after real output (e.g. announce
 * delivery). When the text is chunked for sending, the trailing token would
 * otherwise leak as a visible message (#30692).
 */
export function stripTrailingSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): string | undefined {
  if (!text) {
    return text;
  }
  const escaped = escapeRegExp(token);
  // Remove the token only when it appears as the last non-whitespace segment,
  // separated from preceding content by at least one newline.
  const re = new RegExp(`\\n\\s*${escaped}\\s*$`);
  const stripped = text.replace(re, "");
  // Only return the stripped version if there is substantive content left.
  return stripped.trim() ? stripped : text;
}
