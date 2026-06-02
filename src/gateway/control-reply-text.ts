import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const SUPPRESSED_CONTROL_REPLY_TOKENS = [
  SILENT_REPLY_TOKEN,
  "ANNOUNCE_SKIP",
  "REPLY_SKIP",
] as const;

const MIN_BARE_PREFIX_LENGTH_BY_TOKEN: Readonly<
  Record<(typeof SUPPRESSED_CONTROL_REPLY_TOKENS)[number], number>
> = {
  [SILENT_REPLY_TOKEN]: 2,
  ANNOUNCE_SKIP: 3,
  REPLY_SKIP: 3,
};

function normalizeSuppressedControlReplyFragment(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = trimmed.toUpperCase();
  if (/[^A-Z_]/.test(normalized)) {
    return "";
  }
  return normalized;
}

/** Detect complete internal reply-control tokens before they reach chat display. */
export function isSuppressedControlReplyText(text: string): boolean {
  const normalized = text.trim();
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token));
}

/**
 * Detect partial streamed control tokens before enough text arrives to hide them exactly.
 *
 * Bare prefixes require a minimum length/case match so ordinary short words do
 * not disappear while `ANNOUNCE_SKIP` / `REPLY_SKIP` are still being streamed.
 */
export function isSuppressedControlReplyLeadFragment(text: string): boolean {
  const trimmed = text.trim();
  const normalized = normalizeSuppressedControlReplyFragment(text);
  if (!normalized) {
    return false;
  }
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => {
    const tokenUpper = token.toUpperCase();
    if (normalized === tokenUpper) {
      return false;
    }
    if (!tokenUpper.startsWith(normalized)) {
      return false;
    }
    if (normalized.includes("_")) {
      return true;
    }
    if (token !== SILENT_REPLY_TOKEN && trimmed !== trimmed.toUpperCase()) {
      return false;
    }
    return normalized.length >= MIN_BARE_PREFIX_LENGTH_BY_TOKEN[token];
  });
}
