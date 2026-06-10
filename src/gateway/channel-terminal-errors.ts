/**
 * Terminal channel-error classification (channel-error-hardening Phase A).
 *
 * A terminal error is one that will never succeed without human action —
 * e.g. a revoked/invalid bot token. Retrying it hammers the provider API,
 * burns CPU, and floods logs (mikyhelper/productguy incidents: weeks of
 * Telegram 401 `getMe` loops). A matched error pauses the account's
 * auto-restart for TERMINAL_ERROR_RETRY_MS; the single retry after expiry
 * doubles as the hourly re-probe, so a token fixed out-of-band recovers
 * within an hour, and an explicit channel start clears the pause immediately.
 */
export const TERMINAL_ERROR_RETRY_MS = 60 * 60_000;

const TERMINAL_PATTERNS: RegExp[] = [
  // grammY formats Bot API errors as: "Call to 'getMe' failed! (401: Unauthorized)"
  /\(401: Unauthorized\)/i,
  /\(404: Not Found\)/i,
  // generic fallbacks for other channel adapters
  /\b401 Unauthorized\b/i,
  /invalid (bot )?token/i,
];

export function isTerminalChannelError(message: string): boolean {
  return TERMINAL_PATTERNS.some((re) => re.test(message));
}
