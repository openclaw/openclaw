/**
 * Redacts sensitive tokens from config output, logs, and error messages.
 *
 * T-ACCESS-003 residual risk: tokens visible in plaintext.
 * This doesn't solve at-rest encryption but prevents accidental
 * exposure through CLI output, log files, and error stack traces.
 */

const TOKEN_PATTERN = /("token"\s*:\s*")([a-f0-9]{16,})(")/gi;
const BEARER_PATTERN = /(Bearer\s+)([a-f0-9]{16,})/gi;

/**
 * Replace token values with a redacted placeholder.
 * Keeps first 4 and last 4 characters for debugging.
 */
export function redactTokens(input: string): string {
  return input
    .replace(TOKEN_PATTERN, (_match, pre, token, post) => {
      return `${pre}${mask(token)}${post}`;
    })
    .replace(BEARER_PATTERN, (_match, pre, token) => {
      return `${pre}${mask(token)}`;
    });
}

function mask(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

/**
 * Wraps console.log/warn/error to automatically redact tokens.
 * Call once at gateway startup.
 */
export function installLogRedaction(): void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: any[]) => {
      const redacted = args.map((a) =>
        typeof a === "string" ? redactTokens(a) : a
      );
      original[level].apply(console, redacted);
    };
  }
}
