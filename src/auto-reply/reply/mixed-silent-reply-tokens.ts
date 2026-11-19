import { SILENT_REPLY_TOKEN } from "../tokens.js";

const LEADING_SILENT_REPLY_LINE = new RegExp(`^${SILENT_REPLY_TOKEN}(?:\\r\\n|\\r|\\n)`, "iu");

/** Removes one standalone leading control line without changing the remaining text. */
export function stripMixedSilentReplyTokens(text: string): string | null {
  const match = LEADING_SILENT_REPLY_LINE.exec(text);
  return match ? text.slice(match[0].length) : null;
}
