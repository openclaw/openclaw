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
  const raw = text.trimStart();
  const normalized = raw.toUpperCase();
  if (!normalized) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }

  const upperToken = token.toUpperCase();
  if (normalized.includes("_")) {
    return upperToken.startsWith(normalized);
  }

  // Only treat alpha-only prefixes as control-token prefixes when the source
  // chunk is already uppercase. This keeps natural-language "No" replies visible
  // while suppressing streamed "NO" fragments of NO_REPLY.
  if (raw !== raw.toUpperCase()) {
    return false;
  }

  const alphaPrefix = upperToken.split("_", 1)[0] ?? upperToken;
  return alphaPrefix.startsWith(normalized);
}
