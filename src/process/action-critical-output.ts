/**
 * Shared classifier for action-critical output lines.
 *
 * Identifies lines that must be preserved in interactive command results
 * (auth/setup prompts, device codes, callback URLs) and redacted in
 * broadcast delivery.
 *
 * Used by:
 * - Interactive/async truncation preservation (issue #96346)
 * - Cron broadcast delivery redaction (PR #95809)
 *
 * Design invariant: classification is stateless and line-based.
 * A line is action-critical if it matches any of the patterns below.
 */

// Patterns for action-critical lines.
// Each pattern is tested against individual lines (not multi-line text).
const ACTION_CRITICAL_PATTERNS: readonly RegExp[] = [
  // Device-login URLs
  /login\.microsoft\.com\/device/i,
  /microsoft\.com\/devicelogin/i,

  // Device/setup/verification code patterns
  /code:\s*\w{4,}(?:[-\s]\w{4,})+/, // code: XXXX-XXXX or code: XXXX XXXX
  /enter the code\s/i,
  /enter this code/i,
  /verification code/i,
  /setup code/i,
  /device code/i,

  // Localhost/device/callback URLs
  /https?:\/\/localhost:\d+/,
  /https?:\/\/127\.0\.0\.1:\d+/,

  // Explicit next-action instructions
  /(?:enter|use|copy|paste|open)\s+(?:this|the)\s+(?:code|url|link|page)/i,
  /to\s+(?:sign\s+in|authenticate|continue|complete)/i,
  /open\s+(?:a\s+)?(?:web\s+)?browser/i,
  /go to\s+(?:https?:\/\/)/i,
];

/**
 * Returns true if the given line contains action-critical content
 * that should be preserved during output truncation.
 */
export function isActionCriticalLine(line: string): boolean {
  return ACTION_CRITICAL_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Extracts all action-critical lines from a multi-line text string.
 * Empty lines and lines without action-critical content are excluded.
 */
export function extractActionCriticalLines(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    if (isActionCriticalLine(line)) {
      result.push(line);
    }
  }
  return result;
}

/**
 * Returns true if the text contains any action-critical content.
 * Faster than extractActionCriticalLines when you only need a boolean.
 */
export function hasActionCriticalContent(text: string): boolean {
  return ACTION_CRITICAL_PATTERNS.some((pattern) => pattern.test(text));
}
