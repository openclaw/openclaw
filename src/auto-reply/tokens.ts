import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

const silentExactRegexByToken = new Map<string, RegExp>();
const silentTrailingRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`^\\s*${escaped}\\s*$`);
  silentExactRegexByToken.set(token, regex);
  return regex;
}

function getSilentTrailingRegex(token: string): RegExp {
  const cached = silentTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`);
  silentTrailingRegexByToken.set(token, regex);
  return regex;
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents substantive replies ending with NO_REPLY from being suppressed (#19537).
  return getSilentExactRegex(token).test(text);
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
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
  // Accept all-uppercase OR all-lowercase token-like strings (letters +
  // underscores only). Reject mixed-case natural language like "No" or "Not"
  // which are common real words, not sentinel prefixes.
  const isAllUpper = /^[A-Z_]+$/.test(trimmed);
  const isAllLower = /^[a-z_]+$/.test(trimmed);
  if (!isAllUpper && !isAllLower) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  const upperToken = token.toUpperCase();
  if (!upperToken.startsWith(normalized)) {
    return false;
  }
  // Require at least the first word of the token (up to the first underscore)
  // to avoid false-positives on single-letter prefixes like "N" while still
  // catching "NO" (the first word of "NO_REPLY") which leaks into Slack streams.
  const firstWordEnd = upperToken.indexOf("_");
  const minLen = firstWordEnd > 0 ? firstWordEnd : upperToken.length;
  return normalized.length >= minLen;
}
