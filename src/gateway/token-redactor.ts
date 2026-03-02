/**
 * Redacts sensitive tokens from config output, logs, and error messages.
 *
 * T-ACCESS-003 residual risk: tokens visible in plaintext.
 * This prevents accidental exposure through CLI output, log files,
 * and error stack traces.
 */

// Matches "token": "any-string-value"
const TOKEN_FIELD_PATTERN = /("token"\s*:\s*")([^"]{8,})(")/gi;

// Matches Bearer tokens: hex, base64url, JWT (header.payload.signature)
const BEARER_PATTERN = /(Bearer\s+)([A-Za-z0-9_\-\.]{16,})/g;

// Matches standalone hex tokens (API keys, session IDs)
const HEX_TOKEN_PATTERN = /\b([a-f0-9]{32,})\b/gi;

function mask(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

export function redactTokens(input: string): string {
  return input
    .replace(TOKEN_FIELD_PATTERN, (_m, pre, token, post) => {
      return `${pre}${mask(token)}${post}`;
    })
    .replace(BEARER_PATTERN, (_m, pre, token) => {
      return `${pre}${mask(token)}`;
    })
    .replace(HEX_TOKEN_PATTERN, (token) => {
      return mask(token);
    });
}

/**
 * Convert any argument to a string for redaction.
 */
function stringify(arg: any): any {
  if (typeof arg === "string") return redactTokens(arg);
  if (arg instanceof Error) {
    arg.message = redactTokens(arg.message);
    if (arg.stack) arg.stack = redactTokens(arg.stack);
    return arg;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      const serialized = JSON.stringify(arg);
      return JSON.parse(redactTokens(serialized));
    } catch {
      return arg;
    }
  }
  return arg;
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
      const redacted = args.map(stringify);
      original[level].apply(console, redacted);
    };
  }
}
