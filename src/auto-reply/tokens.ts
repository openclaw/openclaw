import { escapeRegExp } from "../shared/regexp.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

const silentExactRegexByToken = new Map<string, RegExp>();
const silentTrailingRegexByToken = new Map<string, RegExp>();
const silentLeadingAttachedRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`^\\s*${escaped}\\s*$`, "i");
  silentExactRegexByToken.set(token, regex);
  return regex;
}

function getSilentTrailingRegex(token: string): RegExp {
  const cached = silentTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|\\s+|\\*+)${escaped}\\s*$`, "i");
  silentTrailingRegexByToken.set(token, regex);
  return regex;
}

const silentReasoningTrailingRegexByToken = new Map<string, RegExp>();

function getSilentReasoningTrailingRegex(token: string): RegExp {
  const cached = silentReasoningTrailingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Dedicated, more tolerant trailing match for the reasoning-prefaced silent
  // reply check: allows whitespace, asterisks, or common sentence punctuation
  // to precede the trailing token so concluding model prose like
  // "Therefore, I should output NO_REPLY.NO_REPLY" collapses cleanly. Kept
  // separate from `getSilentTrailingRegex` to preserve the long-standing
  // `stripSilentToken("interject.NO_REPLY")` no-op contract.
  const regex = new RegExp(`(?:^|[\\s.:;,!?*]+)${escaped}\\s*$`, "i");
  silentReasoningTrailingRegexByToken.set(token, regex);
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

type SilentReplyActionEnvelope = { action?: unknown };

function isSilentReplyEnvelopeText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(token)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as SilentReplyActionEnvelope;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === "action" &&
      typeof parsed.action === "string" &&
      parsed.action.trim() === token
    );
  } catch {
    return false;
  }
}

export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return (
    isSilentReplyText(text, token) ||
    isSilentReplyEnvelopeText(text, token) ||
    isReasoningPrefacedSilentReply(text, token)
  );
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
}

function stripTrailingSilentTokensTolerant(text: string, token: string): string {
  const regex = getSilentReasoningTrailingRegex(token);
  let current = text;
  // Iterate so doubled/tripled trailing forms (for example
  // "NO_REPLY.NO_REPLY" or "NO_REPLY NO_REPLY") collapse cleanly. Capped at 8
  // iterations — in practice the loop exits after 1-3 passes.
  for (let i = 0; i < 8; i++) {
    const next = current.replace(regex, "").trim();
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

// Matches a bare reasoning preamble at the start of the message: a word like
// "think", "thinking", "thought", "reasoning", or "analysis" on its own line
// (optionally followed by a colon) with nothing else on that line. Reasoning
// models occasionally leak their chain-of-thought as plain text content when
// structured thinking stream events are not produced; those messages must not
// be treated as substantive replies when they are followed by a silent-reply
// sentinel like NO_REPLY. The proper XML-tag stripper in
// src/shared/text/reasoning-tags.ts cannot catch this form because there are
// no tags to match.
const BARE_REASONING_PREAMBLE_RE =
  /^\s*(?:think(?:ing)?|thought|reasoning|analysis)\s*:?\s*(?:\r?\n|$)/i;

/**
 * Whether `text` is a reasoning-prefaced silent reply — a message that ends
 * with the silent-reply token and whose preceding content is a bare reasoning
 * preamble (not substantive user-visible content).
 *
 * Preserves the #19537 semantics: substantive replies that happen to end with
 * NO_REPLY are still delivered. Only messages where the non-token content is
 * a reasoning preamble are suppressed.
 */
export function isReasoningPrefacedSilentReply(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  // Use the tolerant trailing strip so concluding model prose like
  // "...I should output NO_REPLY.NO_REPLY" collapses even with inner
  // punctuation between doubled tokens.
  const withoutToken = stripTrailingSilentTokensTolerant(trimmed, token);
  // Must actually end with the silent token (stripping changed the text).
  if (withoutToken === trimmed) {
    return false;
  }
  // All content was silent tokens → nothing left to classify.
  if (!withoutToken) {
    return true;
  }
  // The remaining content must start with a bare reasoning preamble.
  return BARE_REASONING_PREAMBLE_RE.test(withoutToken);
}

const silentLeadingRegexByToken = new Map<string, RegExp>();

function getSilentLeadingAttachedRegex(token: string): RegExp {
  const cached = silentLeadingAttachedRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token where the final token
  // is glued directly to visible word-start content (for example
  // `NO_REPLYhello`), without treating punctuation-start text like
  // `NO_REPLY: explanation` as a silent prefix.
  const regex = new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu");
  silentLeadingAttachedRegexByToken.set(token, regex);
  return regex;
}

function getSilentLeadingRegex(token: string): RegExp {
  const cached = silentLeadingRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match one or more leading occurrences of the token, each optionally followed by whitespace
  const regex = new RegExp(`^(?:\\s*${escaped})+\\s*`, "i");
  silentLeadingRegexByToken.set(token, regex);
  return regex;
}

/**
 * Strip leading silent reply tokens from text.
 * Handles cases like "NO_REPLYThe user is saying..." where the token
 * is not separated from the following text.
 */
export function stripLeadingSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentLeadingRegex(token), "").trim();
}

/**
 * Check whether text starts with one or more leading silent reply tokens where
 * the final token is glued directly to visible content.
 */
export function startsWithSilentToken(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  return getSilentLeadingAttachedRegex(token).test(text);
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
