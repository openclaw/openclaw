import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

const SUPPRESSED_CONTROL_REPLY_TOKENS = [
  SILENT_REPLY_TOKEN,
  "ANNOUNCE_SKIP",
  "REPLY_SKIP",
] as const;

// Whole-phrase control acknowledgements the message tool emits when a visible
// reply was already delivered; they must never leak into chat as assistant text.
const SUPPRESSED_CONTROL_REPLY_PHRASES = ["Visible reply sent.", "Visible reply sent"] as const;

const MIN_BARE_PREFIX_LENGTH_BY_TOKEN: Readonly<
  Record<(typeof SUPPRESSED_CONTROL_REPLY_TOKENS)[number], number>
> = {
  [SILENT_REPLY_TOKEN]: 2,
  ANNOUNCE_SKIP: 3,
  REPLY_SKIP: 3,
};

function isSuppressedControlReplyPhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return SUPPRESSED_CONTROL_REPLY_PHRASES.some((phrase) => normalized === phrase.toLowerCase());
}

function isSuppressedControlReplyPhraseLeadFragment(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 3) {
    return false;
  }
  return SUPPRESSED_CONTROL_REPLY_PHRASES.some((phrase) =>
    phrase.toLowerCase().startsWith(normalized),
  );
}

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

/**
 * Return true when a chat-visible reply is exactly an internal control token.
 */
export function isSuppressedControlReplyText(text: string): boolean {
  const normalized = text.trim();
  return (
    isSuppressedControlReplyPhrase(normalized) ||
    SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => isSilentReplyText(normalized, token))
  );
}

/**
 * Return true when streamed assistant text looks like the leading fragment of a control token.
 */
export function isSuppressedControlReplyLeadFragment(text: string): boolean {
  const trimmed = text.trim();
  if (isSuppressedControlReplyPhraseLeadFragment(trimmed)) {
    return true;
  }
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
