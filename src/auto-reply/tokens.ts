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
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  const escaped = escapeRegExp(token);
  return text.replace(new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`), "").trim();
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  // For fragments that don't yet contain an underscore, only match when the
  // original text is already fully uppercase.  This avoids false positives
  // with natural-language words like "No" or "Heart" while still catching
  // streaming prefixes like "NO" from NO_REPLY (#32168).
  if (!normalized.includes("_") && trimmed !== normalized) {
    return false;
  }
  return token.toUpperCase().startsWith(normalized);
}
