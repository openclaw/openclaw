import { escapeRegExp } from "../utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  // Match only the exact silent token with optional surrounding whitespace.
  // This prevents
  // substantive replies ending with NO_REPLY from being suppressed (#19537).
  return new RegExp(`^\\s*${escaped}\\s*$`).test(text);
}

/**
 * Strip trailing NO_REPLY tokens from agent output so real content isn't
 * delivered with the raw token appended.  LLMs occasionally append the silent
 * token after substantive text (e.g. "Here is the answer\n\nNO_REPLY").
 *
 * Returns `{ text, didStrip }`.  When the entire message is just the token
 * (with optional whitespace), `text` will be empty.
 */
export function stripSilentReplyToken(
  raw: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): { text: string; didStrip: boolean } {
  if (!raw) {
    return { text: "", didStrip: false };
  }

  const escaped = escapeRegExp(token);
  // Match the token at the very end, preceded by at least one whitespace char
  // (newline, space, etc.) so we don't mangle words that happen to end with
  // the token substring.  Also allow optional trailing whitespace/punctuation
  // after the token itself (e.g. "NO_REPLY." or "NO_REPLY\n").
  const trailingRe = new RegExp(`\\s+${escaped}[^\\w]{0,4}\\s*$`);

  let text = raw;
  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    if (trailingRe.test(text)) {
      const idx = text.search(trailingRe);
      text = text.slice(0, idx);
      didStrip = true;
      changed = true;
    }
  }

  return { text: text.trimEnd(), didStrip };
}

export function isSilentReplyPrefixText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trimStart().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (!normalized.includes("_")) {
    return false;
  }
  if (/[^A-Z_]/.test(normalized)) {
    return false;
  }
  return token.toUpperCase().startsWith(normalized);
}
