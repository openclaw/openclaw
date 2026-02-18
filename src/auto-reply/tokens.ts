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
  // Token at start, followed only by ASCII (allows "NO_REPLY -- explanation" but not CJK)
  const prefixRe = new RegExp(`^\\s*${escaped}(?![a-zA-Z0-9_])`);
  if (prefixRe.test(text)) {
    const rest = text.replace(new RegExp(`^\\s*${escaped}`), "");
    if (/^[\t\n\r\x20-\x7e]*$/.test(rest)) {
      return true;
    }
  }
  // Token at end, preceded only by ASCII
  const suffixRe = new RegExp(`(?<![a-zA-Z0-9_])${escaped}\\s*$`);
  if (suffixRe.test(text)) {
    const before = text.replace(new RegExp(`${escaped}\\s*$`), "");
    if (/^[\t\n\r\x20-\x7e]*$/.test(before)) {
      return true;
    }
  }
  return false;
}
