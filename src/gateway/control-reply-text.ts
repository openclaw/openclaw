// Gateway control-reply text classifier.
// Suppresses internal auto-reply tokens before they leak to chat surfaces.
import { isSilentReplyText, SILENT_REPLY_TOKEN, stripSilentToken } from "../auto-reply/tokens.js";

const SUPPRESSED_CONTROL_REPLY_TOKENS = [
  SILENT_REPLY_TOKEN,
  "ANNOUNCE_SKIP",
  "REPLY_SKIP",
] as const;

// Long padding falls through to the full classifier without another unbounded scan.
const POSSIBLE_CONTROL_REPLY_START = new RegExp(
  `^(?:[\\s\\p{P}]{64}|[\\s\\p{P}]{0,63}(?:${SUPPRESSED_CONTROL_REPLY_TOKENS.join("|")}))`,
  "iu",
);

const CONTROL_REPLY_SEQUENCE_PREFIX = new RegExp(
  `^(?:(?:${SUPPRESSED_CONTROL_REPLY_TOKENS.join("|")})\\s+)+([A-Z_]+)$`,
  "i",
);

/**
 * Recognize control-only replies, including a repeated marker's unfinished tail.
 */
export function isSuppressedControlReplyText(text: string): boolean {
  if (!POSSIBLE_CONTROL_REPLY_START.test(text)) {
    return false;
  }
  const normalized = text.trim();
  const repeatedFragment = CONTROL_REPLY_SEQUENCE_PREFIX.exec(normalized)?.[1]?.toUpperCase();
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some(
    (token) =>
      isSilentReplyText(normalized, token) ||
      (repeatedFragment !== undefined && token.startsWith(repeatedFragment)),
  );
}

/** Remove internal control tokens when a model appends one to visible reply text. */
export function stripSuppressedControlReplyToken(text: string): string {
  if (isSuppressedControlReplyText(text)) {
    return "";
  }
  let stripped = text;
  for (const token of SUPPRESSED_CONTROL_REPLY_TOKENS) {
    const next = stripSilentToken(stripped, token);
    if (next !== stripped.trim()) {
      stripped = next;
    }
  }
  return stripped;
}

/**
 * Return true when streamed assistant text looks like the leading fragment of a control token.
 */
export function isSuppressedControlReplyLeadFragment(text: string): boolean {
  const trimmed = text.trim();
  return SUPPRESSED_CONTROL_REPLY_TOKENS.some((token) => {
    let fragment = trimmed;
    // Separate assistant messages share a live buffer. Consume only complete,
    // whitespace-delimited controls before inspecting the next token's prefix.
    // Fixed-size lookahead keeps ordinary growing replies off a full-text scan.
    while (
      fragment.length > token.length &&
      fragment.slice(0, token.length).toUpperCase() === token &&
      /\s/.test(fragment.charAt(token.length))
    ) {
      fragment = fragment.slice(token.length).trimStart();
    }
    // Hold even a single character until it diverges or the turn finishes;
    // terminal projection releases ordinary short replies such as "RE".
    return (
      fragment.length > 0 &&
      fragment.length < token.length &&
      token.startsWith(fragment.toUpperCase())
    );
  });
}
