import { escapeRegExp } from "../shared/regexp.js";

/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";
/** Exact first line of an unattended automation reply that records the run as failed. */
export const AUTOMATION_FAILED_TOKEN = "AUTOMATION_FAILED";

const HARMONY_CHANNEL_MARKER_RE = /^\s*(?:set-thought\s+)?<[\w]*\|[^>]*>\s*$/;
const BOX_DRAWING_HR_ONLY_RE = /^\s*─{3,}\s*$/;

export function isInternalFormattingArtifact(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return HARMONY_CHANNEL_MARKER_RE.test(text) || BOX_DRAWING_HR_ONLY_RE.test(text);
}

function createTokenRegex(createRegex: (escaped: string) => RegExp) {
  const regexByToken = new Map<string, RegExp>();
  return (token: string): RegExp => {
    const cached = regexByToken.get(token);
    if (cached) {
      return cached;
    }
    const regex = createRegex(escapeRegExp(token));
    regexByToken.set(token, regex);
    return regex;
  };
}

const getSilentExactRegex = createTokenRegex(
  (escaped) => new RegExp(`^\\s*${escaped}(?:\\s+${escaped})*\\s*$`, "i"),
);

// Keep main's whitespace/Markdown boundaries: punctuation-attached tokens
// can be visible text. Consume repeated tokens only after a real delimiter.
// Start at the end so ordinary replies never scan for an absent suffix.
const getSilentTrailingRegex = createTokenRegex(
  (escaped) => new RegExp(`$(?<=((?:^|\\s+|\\*+)${escaped}(?:\\s+${escaped})*\\s*))`, "i"),
);

function stripEdgePunctuation(text: string): string {
  const start = text.match(/^\p{P}+/u)?.[0].length ?? 0;
  // Anchor at the end before matching backwards, so ordinary replies do not
  // get scanned in full while searching for a punctuation suffix.
  const tail = text.match(/$(?<=(\p{P}+))/u)?.[1]?.length ?? 0;
  return text.slice(start, text.length - tail);
}

/** Returns true only for token-only silent replies. */
export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  // Match only token-only replies, including repeated tokens separated by whitespace.
  // This prevents substantive replies ending with NO_REPLY from being suppressed (#19537).
  // Models sometimes wrap the token in punctuation. Preserve exact custom-token matching,
  // but keep symbols such as emoji substantive so they are still delivered.
  return (
    getSilentExactRegex(token).test(text) ||
    getSilentExactRegex(token).test(stripEdgePunctuation(text.trim()))
  );
}

function isSilentReplyJsonText(text: string | undefined, token: string): boolean {
  const trimmed = text?.trim();
  if (
    !trimmed ||
    !trimmed.includes(token) ||
    !(
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    )
  ) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed.trim() === token;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const keys = Object.keys(parsed);
    return (
      keys.length === 1 &&
      keys[0] === "action" &&
      "action" in parsed &&
      typeof parsed.action === "string" &&
      parsed.action.trim() === token
    );
  } catch {
    return false;
  }
}

const taggedReasoningPrefixRe =
  /^\s*<\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\s*>\s*/i;
const openReasoningPrefixRe =
  /^\s*<\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/i;
const plainReasoningPrefixRe = /^\s*(?:think(?:ing)?|thought|analysis|reasoning)\s*:?\s*\r?\n/i;

function stripLeadingReasoningBlocks(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(taggedReasoningPrefixRe, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function stripFinalSilentToken(text: string, token: string): string | null {
  const escaped = escapeRegExp(token);
  // Tolerate punctuation-attached trailing tokens (for example `NO_REPLY.`),
  // mirroring isSilentReplyText's handling of punctuation-wrapped token-only text.
  const stripped = text
    .replace(new RegExp(`(?:^|[\\s*.])${escaped}(?:[.!?]+\\s*)?$`, "i"), "")
    .trim();
  return stripped === text.trim() ? null : stripped;
}

const silentIntentTextRe =
  /^\s*(?:i|i'll|i\s+will|i'm|i\s+am|we|we'll|we\s+will|the\s+assistant|assistant|the\s+bot|bot|openclaw)\s+(?:(?:will\s+)?(?:stay|remain|keep|be)\s+(?:quiet|silent)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:do\s+not|don't|dont|will\s+not|won't|would\s+not|should\s+not)\s+(?:reply|respond)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:have|has)\s+nothing\s+(?:to|for)\s+(?:say|add|reply|respond))(?:[.!?]+)?\s*$/i;

const substantiveAnswerCueRe =
  /\b(?:answer|here(?:'s|\s+is)|tell\s+them|you\s+(?:should|can|could|need|must)|please|try|use|send|service\s+is|resolved|retry|yes|no,|sure)\b/i;
const bareReasoningPlaceholderRe =
  /^\s*(?:(?:internal|private)\s+)?(?:reasoning|thinking|thoughts?|analysis)(?:\s+notes?)?\s*$/i;

// A standalone mention of the token inside the reasoning body itself (for
// example `The correct move: NO_REPLY.`) is a deliberate silent decision,
// not prose that happens to contain the token (#165025).
const getSilentBodyMentionRegex = createTokenRegex(
  (escaped) => new RegExp(`(?:^|[\\s*.])${escaped}(?=$|[\\s*.,:;!?])`, "i"),
);

function hasReasoningFinalSilentToken(
  text: string,
  token: string,
  allowPlainReasoning: boolean,
): boolean {
  const withoutToken = stripFinalSilentToken(text, token);
  if (withoutToken === null) {
    return false;
  }
  if (!withoutToken || silentIntentTextRe.test(withoutToken)) {
    return true;
  }
  if (!allowPlainReasoning) {
    return false;
  }
  const lines = withoutToken
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const finalLine = lines.at(-1);
  const previousLines = lines.slice(0, -1).join("\n");
  return (
    Boolean(
      finalLine &&
      silentIntentTextRe.test(finalLine) &&
      previousLines &&
      !substantiveAnswerCueRe.test(previousLines),
    ) ||
    bareReasoningPlaceholderRe.test(withoutToken) ||
    Boolean(
      withoutToken &&
      getSilentBodyMentionRegex(token).test(withoutToken) &&
      !substantiveAnswerCueRe.test(withoutToken),
    )
  );
}

function isReasoningPrefixedSilentReplyText(text: string | undefined, token: string): boolean {
  const trimmed = text?.trim();
  if (!trimmed) {
    return false;
  }

  const withoutLeadingReasoningBlocks = stripLeadingReasoningBlocks(trimmed);
  if (withoutLeadingReasoningBlocks !== trimmed) {
    return (
      isSilentReplyText(withoutLeadingReasoningBlocks, token) ||
      hasReasoningFinalSilentToken(withoutLeadingReasoningBlocks, token, false)
    );
  }

  const reasoningPrefix = openReasoningPrefixRe.test(trimmed)
    ? openReasoningPrefixRe
    : plainReasoningPrefixRe.test(trimmed)
      ? plainReasoningPrefixRe
      : undefined;
  if (!reasoningPrefix) {
    return false;
  }
  const withoutReasoningPrefix = trimmed.replace(reasoningPrefix, "");
  return (
    isSilentReplyText(withoutReasoningPrefix, token) ||
    hasReasoningFinalSilentToken(withoutReasoningPrefix, token, true)
  );
}

/** Returns true for token-only, JSON-envelope, or reasoning-prefixed silent payload text. */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return (
    isSilentReplyText(text, token) ||
    isSilentReplyJsonText(text, token) ||
    isReasoningPrefixedSilentReplyText(text, token)
  );
}

/**
 * Strip a trailing silent reply token from mixed-content text.
 * Returns the remaining text with the token removed (trimmed).
 * If the result is empty, the entire message should be treated as silent.
 */
export function stripSilentToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  const tail = getSilentTrailingRegex(token).exec(text)?.[1]?.length ?? 0;
  return text.slice(0, text.length - tail).trim();
}

// Match one or more leading occurrences of the token where the final token
// is glued directly to visible word-start content (for example
// `NO_REPLYhello`), without treating punctuation-start text like
// `NO_REPLY: explanation` as a silent prefix.
const getSilentLeadingAttachedRegex = createTokenRegex(
  (escaped) => new RegExp(`^\\s*(?:${escaped}\\s+)*${escaped}(?=[\\p{L}\\p{N}])`, "iu"),
);

// Keep the final separator distinct: earlier blank lines or spacing between
// repeated sentinels do not establish a boundary for the visible remainder.
const getSilentLeadingRegex = createTokenRegex(
  (escaped) => new RegExp(`^\\s*${escaped}((?:\\s*${escaped})*)(\\s*)`, "i"),
);

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
  if (getSilentLeadingAttachedRegex(token).test(text)) {
    return true;
  }
  const leading = getSilentLeadingRegex(token).exec(text);
  // Only the separator after the final sentinel establishes a boundary; a
  // leading blank line must not turn same-line token mentions into controls.
  if (!leading || !/[\r\n]/.test(leading[2] ?? "")) {
    return false;
  }
  return text.slice(leading[0].length).trimStart().length > 0;
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const tokenUpper = token.toUpperCase();
  const trimmed = text.trimStart();
  // Uppercasing never shortens text, so overlong candidates cannot match.
  // Reject before scanning each streamed reply's growing buffer.
  if (!trimmed || trimmed.length > tokenUpper.length) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  // Guard against suppressing natural-language "No..." text while still
  // catching uppercase lead fragments like "NO" from streamed NO_REPLY.
  if (trimmed !== normalized || normalized.length < 2 || !tokenUpper.startsWith(normalized)) {
    return false;
  }
  // Full-token match is safe for any token.
  if (normalized.includes("_") || normalized === tokenUpper) {
    return true;
  }
  // For custom tokens containing non-letter characters (digits, hyphens),
  // only match if the prefix includes at least one non-letter character
  // from the token. Otherwise, a pure-letter prefix like "HE" for "HELP-QUIET"
  // would suppress natural language that happens to share that prefix (#100007).
  if (/[^A-Z_]/.test(tokenUpper)) {
    return /[^A-Z_]/.test(normalized);
  }
  return tokenUpper === SILENT_REPLY_TOKEN && normalized === "NO";
}
