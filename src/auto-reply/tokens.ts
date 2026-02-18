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
  const trimmed = text.trim();
  if (trimmed === token) {
    return true;
  }
  const escaped = escapeRegExp(token);
  // Token at start, NOT followed by a word char, and rest is ASCII-only
  const prefixRe = new RegExp(`^\\s*${escaped}(?![a-zA-Z0-9_])`);
  if (prefixRe.test(text)) {
    const rest = text.replace(new RegExp(`^\\s*${escaped}`), "");
    if (/^[\x00-\x7f]*$/.test(rest)) {
      return true;
    }
  }
  // Token at end, NOT preceded by a word char, and prefix is ASCII-only
  const suffixRe = new RegExp(`(?<![a-zA-Z0-9_])${escaped}\\s*$`);
  if (suffixRe.test(text)) {
    const before = text.replace(new RegExp(`${escaped}\\s*$`), "");
    if (/^[\x00-\x7f]*$/.test(before)) {
      return true;
    }
  }
  return false;
}
