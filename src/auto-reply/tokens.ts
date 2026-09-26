/** Silent-reply and heartbeat tokens plus helpers for suppressing token-only model output. */
import { escapeRegExp } from "../shared/regexp.js";

/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";

const HARMONY_CHANNEL_MARKER_RE = /^\s*(?:set-thought\s+)?<[\w]*\|[^>]*>\s*$/;
const BOX_DRAWING_HR_ONLY_RE = /^\s*─{3,}\s*$/;

// Anthropic-style tool-call markup a model can emit as plain assistant text (#153594).
// Everything below is scanned by walking characters. A regex over repeated blocks can expand a
// parameter body past its closing tag (dropping prose between blocks), backtrack exponentially on a
// rejecting suffix, and — because `<\s*\/?\s*name` repeats whitespace either side of an optional
// slash — explore every partition of a run of spaces inside one malformed tag before the scan can
// advance.
const TOOL_CALL_NAMES = ["function_calls", "invoke", "parameter"] as const;
const NAMESPACE_PREFIXES = ["antml:", "mm:"] as const;

type ToolCallTag = { closing: boolean; name: string; selfClosing: boolean };

/**
 * Parses `< [/] [antml:|mm:] name … >` by walking it once. `raw` starts with `<`, ends with `>`,
 * and contains no other angle bracket, so one forward pass is enough and no amount of whitespace
 * can send the matcher back to try another split.
 */
function parseToolCallTag(raw: string): ToolCallTag | null {
  const end = raw.length - 1;
  const isSpace = (char: string) => /\s/.test(char);
  let index = 1;
  while (index < end && isSpace(raw[index] ?? "")) {
    index += 1;
  }
  let closing = false;
  if (raw[index] === "/") {
    closing = true;
    index += 1;
    while (index < end && isSpace(raw[index] ?? "")) {
      index += 1;
    }
  }
  const lower = raw.toLowerCase();
  for (const prefix of NAMESPACE_PREFIXES) {
    if (lower.startsWith(prefix, index)) {
      index += prefix.length;
      break;
    }
  }
  const name = TOOL_CALL_NAMES.find((candidate) => lower.startsWith(candidate, index));
  if (name === undefined) {
    return null;
  }
  index += name.length;
  // The name needs a delimiter, which keeps lookalike element names such as `<parameter-value>` out.
  const next = index < end ? (raw[index] ?? "") : ">";
  if (next !== "/" && next !== ">" && !isSpace(next)) {
    return null;
  }
  let tail = end - 1;
  while (tail > index && isSpace(raw[tail] ?? "")) {
    tail -= 1;
  }
  return { closing, name, selfClosing: raw[tail] === "/" };
}

/**
 * An artifact is markup the model wrote as ordinary reply text. Markup the sanitizer already owns
 * as Markdown code is not an artifact: `    <invoke …>` is an indented code sample the user asked
 * for, and `sanitizeUserFacingText` protects code regions for exactly that reason. The caller knows
 * the code regions, so this module stays free of Markdown and only asks about offsets.
 */
export type InternalFormattingArtifactOptions = {
  /** True when the offset sits inside a protected region, treated as literal text. */
  isProtected?: (offset: number) => boolean;
};

// True only for a whole invocation: an `<invoke>`/`<function_calls>` outside parameter content,
// with every non-whitespace character inside a `<parameter>` payload. A standalone parameter
// wrapper keeps its content (assistant-visible-text unwraps it), and the delimiter check in
// parseToolCallTag keeps lookalike element names such as `<parameter-value>` out.
function isToolCallMarkupOnly(text: string, isProtected?: (offset: number) => boolean): boolean {
  let parameterDepth = 0;
  let hasInvocation = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char !== "<") {
      if (parameterDepth === 0 && /\S/.test(char)) {
        return false;
      }
      index += 1;
      continue;
    }
    // A tag cannot contain "<" or ">", so it ends at whichever comes first. Stopping there keeps
    // the scan linear: a run of "<" that opens nothing advances one character at a time instead of
    // re-searching the whole remaining suffix for a ">" on every character.
    let close = index + 1;
    while (close < text.length && text[close] !== ">" && text[close] !== "<") {
      close += 1;
    }
    if (close >= text.length) {
      // No ">" remains, so no later tag can close and the depth can never return to zero.
      return false;
    }
    const tag = text[close] === ">" ? parseToolCallTag(text.slice(index, close + 1)) : null;
    if (!tag) {
      // A "<" that opens no tool-call tag is payload text inside a parameter, prose otherwise.
      if (parameterDepth === 0) {
        return false;
      }
      index += 1;
      continue;
    }
    if (isProtected?.(index)) {
      // Code sample, not artifact: leave it for the sanitizer's code-region handling.
      index = close + 1;
      continue;
    }
    if (tag.name === "parameter") {
      if (!tag.selfClosing) {
        parameterDepth += tag.closing ? -1 : 1;
        if (parameterDepth < 0) {
          return false;
        }
      }
    } else if (parameterDepth === 0) {
      hasInvocation = true;
    }
    index = close + 1;
  }
  return hasInvocation && parameterDepth === 0;
}

export function isInternalFormattingArtifact(
  text: string | undefined,
  options: InternalFormattingArtifactOptions = {},
): boolean {
  if (!text) {
    return false;
  }
  return (
    HARMONY_CHANNEL_MARKER_RE.test(text) ||
    BOX_DRAWING_HR_ONLY_RE.test(text) ||
    isToolCallMarkupOnly(text, options.isProtected)
  );
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

type SilentReplyActionEnvelope = { action?: unknown };

function isSilentReplyJsonStringText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || !trimmed.includes(token)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed.trim() === token;
  } catch {
    return false;
  }
}

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
  const stripped = text.replace(new RegExp(`(?:^|[\\s*.])${escaped}\\s*$`, "i"), "").trim();
  return stripped === text.trim() ? null : stripped;
}

const silentIntentTextRe =
  /^\s*(?:i|i'll|i\s+will|i'm|i\s+am|we|we'll|we\s+will|the\s+assistant|assistant|the\s+bot|bot|openclaw)\s+(?:(?:will\s+)?(?:stay|remain|keep|be)\s+(?:quiet|silent)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:do\s+not|don't|dont|will\s+not|won't|would\s+not|should\s+not)\s+(?:reply|respond)(?:\s+(?:here|for\s+now|on\s+this|in\s+this\s+(?:chat|thread|channel|conversation)))?|(?:have|has)\s+nothing\s+(?:to|for)\s+(?:say|add|reply|respond))(?:[.!?]+)?\s*$/i;

function hasSilentIntentFinalSilentToken(text: string, token: string): boolean {
  const withoutToken = stripFinalSilentToken(text, token);
  if (withoutToken === null) {
    return false;
  }
  return !withoutToken || silentIntentTextRe.test(withoutToken);
}

const substantiveAnswerCueRe =
  /\b(?:answer|here(?:'s|\s+is)|tell\s+them|you\s+(?:should|can|could|need|must)|please|try|use|send|service\s+is|resolved|retry|yes|no,|sure)\b/i;
const bareReasoningPlaceholderRe =
  /^\s*(?:(?:internal|private)\s+)?(?:reasoning|thinking|thoughts?|analysis)(?:\s+notes?)?\s*$/i;

function hasPlainReasoningFinalSilentToken(text: string, token: string): boolean {
  const withoutToken = stripFinalSilentToken(text, token);
  if (withoutToken === null) {
    return false;
  }
  if (!withoutToken || silentIntentTextRe.test(withoutToken)) {
    return true;
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
    ) || bareReasoningPlaceholderRe.test(withoutToken)
  );
}

function isReasoningPrefixedSilentReplyText(
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

  const withoutLeadingReasoningBlocks = stripLeadingReasoningBlocks(trimmed);
  if (withoutLeadingReasoningBlocks !== trimmed) {
    return (
      isSilentReplyText(withoutLeadingReasoningBlocks, token) ||
      hasSilentIntentFinalSilentToken(withoutLeadingReasoningBlocks, token)
    );
  }

  if (openReasoningPrefixRe.test(trimmed)) {
    const withoutOpenReasoningPrefix = trimmed.replace(openReasoningPrefixRe, "");
    return (
      isSilentReplyText(withoutOpenReasoningPrefix, token) ||
      hasPlainReasoningFinalSilentToken(withoutOpenReasoningPrefix, token)
    );
  }
  if (!plainReasoningPrefixRe.test(trimmed)) {
    return false;
  }
  const withoutPlainReasoningPrefix = trimmed.replace(plainReasoningPrefixRe, "");
  return (
    isSilentReplyText(withoutPlainReasoningPrefix, token) ||
    hasPlainReasoningFinalSilentToken(withoutPlainReasoningPrefix, token)
  );
}

/** Returns true for token-only, JSON-envelope, or reasoning-prefixed silent payload text. */
export function isSilentReplyPayloadText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return (
    isSilentReplyText(text, token) ||
    isSilentReplyJsonStringText(text, token) ||
    isSilentReplyEnvelopeText(text, token) ||
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
  if (trimmed !== normalized) {
    return false;
  }
  if (normalized.length < 2) {
    return false;
  }
  if (!tokenUpper.startsWith(normalized)) {
    return false;
  }
  if (normalized.includes("_")) {
    return true;
  }
  // Full-token match is safe for any token.
  if (normalized === tokenUpper) {
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
