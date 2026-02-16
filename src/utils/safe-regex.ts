/**
 * Safe regex utilities to prevent ReDoS (CWE-1333) attacks.
 *
 * ReDoS occurs when a regular expression with certain patterns
 * (like nested quantifiers) is matched against crafted input,
 * causing exponential backtracking and CPU exhaustion.
 *
 * Defense strategy (belt + suspenders):
 * 1. Static pattern analysis - instantly reject known-dangerous patterns
 * 2. Input length limit - bound worst-case execution time for edge cases
 *
 * Static analysis catches common ReDoS patterns (nested quantifiers, overlapping
 * alternations). Input limiting handles exotic patterns that slip through by
 * ensuring even pathological cases complete in bounded time.
 */

/** Maximum input length for regex matching (defense-in-depth) */
const MAX_REGEX_INPUT_LENGTH = 1000;

/**
 * Detect potentially dangerous regex patterns that could cause ReDoS.
 * Rejects patterns with nested quantifiers like (a+)+, (a*)+, (a+)*, etc.
 * These can cause exponential backtracking on crafted input.
 *
 * Note: Static analysis cannot catch all pathological patterns (halting problem),
 * but it handles the common cases. Input length limiting provides defense-in-depth.
 *
 * @param pattern - The regex pattern string to validate
 * @returns true if the pattern is considered safe, false otherwise
 */
export function isSafeRegexPattern(pattern: string): boolean {
  // Detect nested quantifiers: groups with quantifiers containing quantified content
  // Patterns like (a+)+, (a*)+, (a+)*, (a|b+)+, (a{2,10})+, etc.
  // Include curly-brace quantifiers {n}, {n,}, {n,m} alongside +*?
  const nestedQuantifierRe = /\([^)]*[+*{][^)]*\)[+*?{]|\([^)]*[+*?{]\)[+*{]/;
  // Also detect nested groups with quantifiers: ((a+))+
  const nestedGroupsRe = /\([^()]*\([^)]*[+*?{][^)]*\)[^()]*\)[+*?{]/;
  if (nestedQuantifierRe.test(pattern) || nestedGroupsRe.test(pattern)) {
    return false;
  }

  // Detect overlapping alternations with quantifiers: (a|a)+, (ab|ab)+
  const overlappingAltRe = /\(([^|)]+)\|\1[^)]*\)[+*]/;
  if (overlappingAltRe.test(pattern)) {
    return false;
  }

  // Reject excessively long patterns (defense in depth)
  if (pattern.length > 500) {
    return false;
  }

  return true;
}

/**
 * Safely test if a string matches a pattern.
 * Falls back to literal string matching if the pattern is unsafe or invalid.
 *
 * Defense layers:
 * 1. Literal match first (O(n), no regex engine)
 * 2. Static pattern analysis (reject known-dangerous patterns)
 * 3. Input length limit (bound worst-case for exotic patterns)
 *
 * @param input - The string to test
 * @param pattern - The pattern (literal string or regex)
 * @param logger - Optional logger for warnings about rejected patterns
 * @returns true if the input matches the pattern
 */
export function safePatternMatch(
  input: string,
  pattern: string,
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): boolean {
  // Always try literal string match first (fast and safe)
  if (input.includes(pattern)) {
    return true;
  }

  // Reject known-dangerous patterns via static analysis
  if (!isSafeRegexPattern(pattern)) {
    logger?.warn("Rejecting potentially dangerous regex pattern", { pattern });
    return false;
  }

  // Defense-in-depth: limit input length to bound worst-case execution time.
  // Even exotic patterns that slip through static analysis will complete
  // in bounded time on limited input. For session keys >1000 chars,
  // fall back to literal match only (already tried above, so return false).
  if (input.length > MAX_REGEX_INPUT_LENGTH) {
    logger?.warn("Input exceeds safe length for regex matching, using literal match only", {
      inputLength: input.length,
      maxLength: MAX_REGEX_INPUT_LENGTH,
    });
    return false;
  }

  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}
