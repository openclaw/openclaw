/**
 * Browser code validation for evaluateViaPlaywright.
 *
 * Prevents execution of code containing dangerous patterns that could be
 * used for data exfiltration, code injection, or other malicious purposes.
 *
 * Related: VULN-037 (Unsafe eval() in Browser Evaluation Functions)
 */

/**
 * Error thrown when code contains unsafe patterns.
 */
export class UnsafeEvaluateCodeError extends Error {
  constructor(pattern: string, _code?: string) {
    // Note: We intentionally don't include the code in the error message to avoid
    // leaking potentially sensitive data (credentials, tokens) into logs.
    super(
      `Unsafe browser code blocked: Contains "${pattern}" which is not allowed for security reasons.`,
    );
    this.name = "UnsafeEvaluateCodeError";
  }
}

/**
 * Patterns that indicate potentially dangerous operations.
 *
 * These patterns are checked case-insensitively and match word boundaries
 * followed by an opening parenthesis (to catch function calls).
 */
const BLOCKED_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  // Data exfiltration APIs
  { pattern: /\bfetch\s*\(/i, name: "fetch" },
  { pattern: /\bXMLHttpRequest\b/i, name: "XMLHttpRequest" },
  { pattern: /\bWebSocket\b/i, name: "WebSocket" },
  { pattern: /\bsendBeacon\s*\(/i, name: "sendBeacon" },
  { pattern: /\bnavigator\s*\.\s*sendBeacon/i, name: "navigator.sendBeacon" },

  // Code execution APIs
  { pattern: /\beval\s*\(/i, name: "eval" },
  { pattern: /\bnew\s+Function\s*\(/i, name: "new Function" },
  { pattern: /\bsetTimeout\s*\(\s*["'`]/i, name: "setTimeout with string" },
  { pattern: /\bsetInterval\s*\(\s*["'`]/i, name: "setInterval with string" },

  // Module loading
  { pattern: /\bimport\s*\(/i, name: "dynamic import" },
  { pattern: /\bimportScripts\s*\(/i, name: "importScripts" },
];

/**
 * Checks if code contains unsafe patterns.
 *
 * @param code - The JavaScript code to check
 * @returns true if the code is unsafe, false if it appears safe
 */
export function isUnsafeEvaluateCode(code: string): boolean {
  if (!code || !code.trim()) {
    return false;
  }

  for (const { pattern } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the name of the first blocked pattern found in the code.
 *
 * @param code - The JavaScript code to check
 * @returns The pattern name if found, null otherwise
 */
export function getBlockedPattern(code: string): string | null {
  if (!code || !code.trim()) {
    return null;
  }

  for (const { pattern, name } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return name;
    }
  }

  return null;
}

/**
 * Asserts that code is safe to evaluate.
 * Throws UnsafeEvaluateCodeError if the code contains unsafe patterns.
 *
 * @param code - The JavaScript code to validate
 * @throws {UnsafeEvaluateCodeError} If code contains blocked patterns
 */
export function assertSafeEvaluateCode(code: string): void {
  const blocked = getBlockedPattern(code);
  if (blocked) {
    throw new UnsafeEvaluateCodeError(blocked, code);
  }
}
