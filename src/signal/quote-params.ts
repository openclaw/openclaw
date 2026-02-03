/**
 * Parse quote parameters for Signal quote-replies.
 *
 * Signal's JSON-RPC requires `quoteTimestamp` (the original message timestamp)
 * and `quoteAuthor` (the phone number of the original sender).
 *
 * For DMs, the quote author is the recipient (the person we're replying to).
 * For groups, we don't have the original author info readily available,
 * so quote-replies are not supported in groups.
 *
 * @param target - The Signal target (e.g., "signal:+1234567890" or "group:abc123")
 * @param replyToId - The message ID to quote (Signal message timestamp as string)
 * @returns Quote parameters for Signal JSON-RPC, or empty object if quoting not possible
 */
export function parseSignalQuoteParams(
  target: string,
  replyToId?: string | null,
): { quoteTimestamp?: number; quoteAuthor?: string } {
  if (!replyToId) {
    return {};
  }
  const timestamp = Number.parseInt(replyToId, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return {};
  }
  // Strip any "signal:" prefix from the target
  let author = target.trim();
  if (author.toLowerCase().startsWith("signal:")) {
    author = author.slice("signal:".length).trim();
  }
  // Don't set author for group targets - we don't have the original sender info
  if (author.toLowerCase().startsWith("group:")) {
    return {};
  }
  return { quoteTimestamp: timestamp, quoteAuthor: author };
}
