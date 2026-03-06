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
  const normalized = trimmed.toUpperCase();
  // Only allow letters and underscores — reject anything that contains
  // spaces, punctuation, or digits (i.e. natural language, not a token).
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  const upperToken = token.toUpperCase();
  if (!upperToken.startsWith(normalized)) {
    return false;
  }
  // When the text already contains an underscore it's unambiguously token-like
  // (natural language doesn't use underscores), so any casing is fine.
  if (trimmed.includes("_")) {
    return true;
  }
  // Without an underscore the text could be a natural language word (e.g. "No",
  // "Not"). Require all-uppercase to distinguish the sentinel prefix "NO" from
  // the English word "No", and require at least the first word of the token to
  // reject single-letter prefixes like "N".
  if (/[^A-Z]/.test(trimmed)) {
    return false;
  }
  const firstWordEnd = upperToken.indexOf("_");
  const minLen = firstWordEnd > 0 ? firstWordEnd : upperToken.length;
  return normalized.length >= minLen;
}
