/**
 * Safe regex utilities to prevent ReDoS (CWE-1333) attacks.
 *
 * ReDoS occurs when a regular expression with certain patterns
 * (like nested quantifiers) is matched against crafted input,
 * causing exponential backtracking and CPU exhaustion.
 */

/**
 * Detect potentially dangerous regex patterns that could cause ReDoS.
 * Rejects patterns with nested quantifiers like (a+)+, (a*)+, (a+)*, etc.
 * These can cause exponential backtracking on crafted input.
 *
 * @param pattern - The regex pattern string to validate
 * @returns true if the pattern is considered safe, false otherwise
 */
export function isSafeRegexPattern(pattern: string): boolean {
  // Detect nested quantifiers: groups with quantifiers containing quantified content
  // Patterns like (a+)+, (a*)+, (a+)*, (a|b+)+, (a{2,10})+, etc.
  // Include curly-brace quantifiers {n}, {n,}, {n,m} alongside +*?
  const nestedQuantifierRe =
    /\([^)]*[+*{][^)]*\)[+*?{]|\([^)]*[+*?{]\)[+*{]/;
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

  // Only attempt regex if the pattern is safe
  if (!isSafeRegexPattern(pattern)) {
    logger?.warn("Rejecting potentially dangerous regex pattern", { pattern });
    return false;
  }

  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}
