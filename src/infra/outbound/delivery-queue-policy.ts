/**
 * Permanent delivery error detection policy.
 * Lives in its own module to avoid circular imports between
 * delivery-queue-storage.ts and delivery-queue-recovery.ts.
 */

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
  // HTTP 4xx client errors — the request itself is invalid and will never succeed on retry.
  // Requires status-code context (e.g. "403 Forbidden", "404: Not Found") to avoid
  // false positives from transient messages that incidentally contain these numbers
  // (e.g. "429 Too Many Requests: retry after 400"). Excludes 429 (rate-limiting).
  /\b(?:400|403|404|405|410|413|415|422)(?::\s|\s+[A-Za-z])/,
  /message is too long/i,
  /request entity too large/i,
  /bad request:/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
