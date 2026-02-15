import { escapeRegExp } from "../utils.js";
import { UNICODE_NON_WORD, UNICODE_WORD_END, UNICODE_WORD_START } from "./unicode-boundaries.js";

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
  const prefix = new RegExp(`^\\s*${escaped}(?=$|${UNICODE_NON_WORD})`, "u");
  if (prefix.test(text)) {
    return true;
  }
  const suffix = new RegExp(`${UNICODE_WORD_START}${escaped}${UNICODE_WORD_END}${UNICODE_NON_WORD}*$`, "u");
  return suffix.test(text);
}
