/**
 * Redacts sensitive tokens from config output, logs, and error messages.
 *
 * T-ACCESS-003 residual risk: tokens visible in plaintext.
 * This prevents accidental exposure through CLI output, log files,
 * and error stack traces.
 */
const TOKEN_FIELD_PATTERN = /("token"\s*:\s*")([^"]{8,})(")/gi;
const BEARER_PATTERN = /(Bearer\s+)([A-Za-z0-9_\-\.]{16,})/g;
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
    // Clone the error to avoid mutating the caller's instance
    const redacted = new Error(redactTokens(arg.message));
    redacted.name = arg.name;
    if (arg.stack) redacted.stack = redactTokens(arg.stack);
    return redacted;
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
 * Wraps all console output methods to automatically redact tokens.
 * Covers log, warn, error, info, and debug.
 * Call once at gateway startup.
 */
export function installLogRedaction(): void {
  const methods = ["log", "warn", "error", "info", "debug"] as const;
  const originals: Record<string, (...args: any[]) => void> = {};
  for (const level of methods) {
    originals[level] = console[level];
    console[level] = (...args: any[]) => {
      const redacted = args.map(stringify);
      originals[level].apply(console, redacted);
    };
  }
}
