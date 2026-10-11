import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";

/** Returns null when mixed-content text has no silent token to normalize. */
export function stripMixedSilentReplyTokens(
  text: string,
  token: string = SILENT_REPLY_TOKEN,
): string | null {
  const hasLeadingToken = startsWithSilentToken(text, token);
  const remainder = hasLeadingToken ? stripLeadingSilentToken(text, token) : text;
  return hasLeadingToken || remainder.toLowerCase().includes(token.toLowerCase())
    ? stripSilentToken(remainder, token)
    : null;
}
