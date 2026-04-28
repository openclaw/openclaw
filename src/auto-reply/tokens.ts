import { escapeRegExp } from "../utils.js";

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

const silentReasoningTrailRegexByToken = new Map<string, RegExp>();

function getSilentReasoningTrailRegex(token: string): RegExp {
  const cached = silentReasoningTrailRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const escaped = escapeRegExp(token);
  // Match the token as the final content of the message, regardless of the
  // character directly before it (whitespace, punctuation, or glued). This is
  // intentionally permissive and must only be combined with an up-front
  // "looks like reasoning" check — never applied to arbitrary text, as that
  // would re-break #19537 (substantive replies that happen to end with the
  // silent token).
  const regex = new RegExp(`${escaped}\\s*$`, "i");
  silentReasoningTrailRegexByToken.set(token, regex);
  return regex;
}

// Heuristic: detect outputs that are nothing but model reasoning followed by
// the silent token. Observed with Gemini / Haiku in group chats where the
// model leaks its chain-of-thought before emitting NO_REPLY, e.g.:
//
//   think
//   Cav is talking about a follow-up conversation...
//   I will stay quiet here.NO_REPLY
//
// or with an explicit XML `<think>...</think>` wrapper. The previous
// exact-match detection required the entire response to be `NO_REPLY`, so
// these reasoning-wrapped outputs leaked the thought process into the chat
// (see #66701).
//
// IMPORTANT: this function MUST NOT classify a message as silent when the
// model emitted a substantive *user-facing* reply alongside the reasoning
// block. The two shapes we recognise have different conventions for where
// "user-facing" begins, so each gets its own predicate (see Codex P1
// review on #66755):
//
//   - <think>...</think> form: anything that lives OUTSIDE the tags
//     before the trailing token is user-facing. If non-empty, NOT silent.
//   - `think\n` form: the entire post-marker block is reasoning unless
//     there is a blank-line separator. After the first blank line,
//     non-empty content is user-facing. If non-empty, NOT silent.
function isReasoningWrappedSilentReply(text: string, token: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const trailRegex = getSilentReasoningTrailRegex(token);

  // Tagged form: <think ...>...</think>. Handle the closed and unclosed
  // cases separately:
  //   - Closed: the trailing token must follow </think>. Anything else
  //     between the close tag and the token is user-facing.
  //   - Unclosed (streaming truncation): the trailing token lives
  //     inside the still-open reasoning region; only classify silent
  //     when the body ends with the token and there is no content
  //     after it.
  const taggedClosed = trimmed.match(/^<think\b[^>]*>([\s\S]*?)<\/think>/i);
  if (taggedClosed) {
    const afterTag = trimmed.slice(taggedClosed[0].length).trim();
    if (!trailRegex.test(afterTag)) {
      return false;
    }
    const remainderAfterToken = afterTag.replace(trailRegex, "").trim();
    return remainderAfterToken === "";
  }
  const taggedOpenOnly = trimmed.match(/^<think\b[^>]*>/i);
  if (taggedOpenOnly) {
    const body = trimmed.slice(taggedOpenOnly[0].length);
    // Token is inside an unclosed reasoning block (streaming
    // truncation). Everything from <think> onward is reasoning, so
    // classify silent iff the body ends with the trailing token.
    return trailRegex.test(body);
  }

  // Bare form: a literal "think" line followed by reasoning lines.
  // Marker only consumes horizontal whitespace + a single newline so a
  // blank-line separator immediately after `think\n` is not eaten by the
  // marker itself (Codex P1 re-review on PR #66755 — `\s*` previously
  // included newlines and could swallow the boundary).
  const bareStart = trimmed.match(/^think[ \t]*\r?\n/i);
  if (bareStart) {
    const afterMarker = trimmed.slice(bareStart[0].length);
    if (!trailRegex.test(afterMarker)) {
      return false;
    }
    // A blank-line separator marks the end of the reasoning block. It
    // can show up as a leading newline at the start of afterMarker
    // (i.e. the marker consumed one of the separator's two newlines)
    // or as a `\n\s*\n` pair somewhere within afterMarker.
    const blankBoundaryAtStart = /^\r?\n/.test(afterMarker);
    const blankBoundaryWithin = afterMarker.search(/\r?\n\s*\r?\n/);
    if (blankBoundaryAtStart || blankBoundaryWithin !== -1) {
      const boundaryIndex = blankBoundaryAtStart ? 0 : blankBoundaryWithin;
      const tailRegion = afterMarker.slice(boundaryIndex);
      const remainderAfterToken = tailRegion.replace(trailRegex, "").trim();
      return remainderAfterToken === "";
    }
    // No blank-line separator: the reasoning/output boundary is
    // ambiguous. Only classify as silent when the trailing token is
    // TRULY adjacent to its preceding text — the character
    // immediately before the token must be non-whitespace. That's
    // the specific #66701 shape (model forgot the newline and
    // produced "...quiet here.NO_REPLY"). Any whitespace separator
    // — newline, tab, or even a single space — is evidence that the
    // reasoning/output boundary might land there, so be conservative
    // and return false (Codex P1 re-reviews on PR #66755).
    const trailMatch = afterMarker.match(trailRegex);
    if (!trailMatch) {
      return false;
    }
    const charBeforeToken = afterMarker.slice(0, trailMatch.index ?? afterMarker.length);
    const trulyAdjacent = charBeforeToken.length > 0 && !/\s$/.test(charBeforeToken);
    return trulyAdjacent;
  }

  return false;
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
  if (getSilentExactRegex(token).test(text)) {
    return true;
  }
  // Narrow exception: the message is clearly just model reasoning plus the
  // silent token (see `isReasoningWrappedSilentReply` above).
  return isReasoningWrappedSilentReply(text, token);
}

type SilentReplyActionEnvelope = { action?: unknown };

export function isSilentReplyEnvelopeText(
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
  return isSilentReplyText(text, token) || isSilentReplyEnvelopeText(text, token);
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  return text.replace(getSilentTrailingRegex(token), "").trim();
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
