import safeRegex from "safe-regex";

const warnedPatterns = new Set<string>();

/**
 * Safely match an input string against a pattern.
 * Tries literal substring match first (fast path), then validates
 * regex complexity with safe-regex before executing.
 *
 * @param input - The string to match against
 * @param pattern - The pattern (literal string or regex)
 * @param logPrefix - Prefix for warning messages
 * @returns true if pattern matches, false otherwise
 */
export function safePatternMatch(
  input: string,
  pattern: string,
  logPrefix = "[pattern-match]",
): boolean {
  // Fast path: literal substring match
  if (input.includes(pattern)) {
    return true;
  }

  try {
    const re = new RegExp(pattern);
    // Validate regex complexity to prevent ReDoS
    if (!safeRegex(re)) {
      if (!warnedPatterns.has(pattern)) {
        warnedPatterns.add(pattern);
        console.warn(`${logPrefix} Rejected potentially unsafe regex pattern: ${pattern}`);
      }
      return false;
    }
    return re.test(input);
  } catch {
    return false;
  }
}
