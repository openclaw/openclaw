import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const IDLE_OK_TOKEN = "IDLE_OK";
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
  if (normalized.length < 2) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  const tokenUpper = token.toUpperCase();
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  if (normalized.includes("_")) {
    return true;
  }
  // Keep underscore guard for generic tokens to avoid suppressing unrelated
  // uppercase words (e.g. HEART/HE with HEARTBEAT_OK). Only allow bare "NO"
  // because NO_REPLY streaming can transiently emit that fragment.
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}
