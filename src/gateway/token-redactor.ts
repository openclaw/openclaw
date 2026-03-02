/**
 * Redacts sensitive tokens from config output, logs, and error messages.
 *
 * T-ACCESS-003 residual risk: tokens visible in plaintext.
 * Prevents accidental exposure through CLI output, log files,
 * and error stack traces.
 */

// Matches "token": "any-string-value" in JSON
const TOKEN_FIELD_PATTERN = /("token"\s*:\s*")([^"]{8,})(")/gi;

// Matches "Bearer <token>" — case-insensitive per RFC 6750
// Covers hex, JWT (base64url with dots), OAuth, and API keys
const BEARER_PATTERN = /(bearer\s+)([\w\-\.]{16,})/gi;

// Matches standalone long hex strings (API keys, session IDs)
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
 * Convert any argument to a redacted copy for logging.
 * Never mutates the original argument.
 */
function stringify(arg: any): any {
  if (typeof arg === "string") return redactTokens(arg);

  if (arg instanceof Error) {
    // Clone to avoid mutating the caller's Error instance
    const clone = new (arg.constructor as ErrorConstructor)(
      redactTokens(arg.message)
    );
    clone.name = arg.name;
    if (arg.stack) clone.stack = redactTokens(arg.stack);
    return clone;
  }

  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.parse(redactTokens(JSON.stringify(arg)));
    } catch {
      return arg;
    }
  }

  return arg;
}

/**
 * Wraps all console output methods to automatically redact tokens.
 * Covers log, info, debug, warn, error, trace, dir, and table.
 * Call once at gateway startup.
 */
export function installLogRedaction(): void {
  const methods = [
    "log", "info", "debug", "warn", "error", "trace", "dir", "table",
  ] as const;

  const originals: Record<string, (...args: any[]) => void> = {};

  for (const level of methods) {
    if (typeof console[level] !== "function") continue;
    originals[level] = console[level];
    (console as any)[level] = (...args: any[]) => {
      const redacted = args.map(stringify);
      originals[level].apply(console, redacted);
    };
  }
}
