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
  // Guard against suppressing natural-language "No..." text while still
  // catching uppercase lead fragments like "NO" from streamed NO_REPLY.
  if (trimmed !== trimmed.toUpperCase()) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (!normalized) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  // Any prefix that already contains an underscore is unambiguously part of the
  // silent token (e.g. "NO_", "NO_RE", "HEARTBEAT_").
  if (normalized.includes("_")) {
    return true;
  }
  // Also allow prefixes up to and including the full pre-underscore segment.
  // During streaming, tokens can arrive as partial fragments: "N", "NO", etc.
  // We hold back any all-uppercase prefix that matches the token to avoid leaking
  // fragments like "NO" before "_REPLY" arrives. This is safe because:
  // - The check requires trimmed text to be STRICTLY uppercase (mixed case → false)
  // - The text must be an exact prefix of the token
  // - Real model replies almost never consist of just "N" or "NO" in all-caps
  //   as their entire accumulated output
  const underscoreIdx = tokenUpper.indexOf("_");
  if (underscoreIdx > 0 && normalized.length <= underscoreIdx) {
    return true;
  }
  return false;
}
