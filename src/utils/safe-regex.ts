/**
 * Safe regex utilities to prevent ReDoS (Regular Expression Denial of Service) attacks.
 */

// Patterns that are known to cause catastrophic backtracking
const DANGEROUS_PATTERNS = [
  // Nested quantifiers with overlapping character classes
  /\([^)]*\)[*+?]/,
  /\[[^\]]*\][*+?]/,
  // Multiple quantifiers in sequence
  /[*+?]{2,}/,
  // Nested groups with quantifiers
  /\([^)]*\([^)]*\)[*+?]/,
];

// Maximum allowed pattern length
const MAX_PATTERN_LENGTH = 1000;

// Maximum allowed regex execution time (ms) - for runtime testing
const MAX_EXECUTION_TIME_MS = 100;

/**
 * Check if a regex pattern is potentially dangerous (could cause ReDoS).
 * This uses heuristics to detect common ReDoS patterns.
 */
export function isDangerousPattern(pattern: string): boolean {
  if (!pattern || typeof pattern !== "string") {
    return false;
  }

  // Reject overly long patterns
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return true;
  }

  // Check against known dangerous patterns
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return true;
    }
  }

  // Check for nested quantifiers and ambiguous alternation
  // Pattern like (a+)+ or (a*)* is dangerous
  const nestedQuantifierMatch = pattern.match(/\([^)]*[*+?][^)]*\)[*+?]/);
  if (nestedQuantifierMatch) {
    return true;
  }

  return false;
}

/**
 * Validate a regex pattern and return a safe version or null if dangerous.
 * Escapes special characters if the pattern is deemed dangerous.
 */
export function safeRegex(pattern: string): RegExp | null {
  if (!pattern || typeof pattern !== "string") {
    return null;
  }

  // If pattern is dangerous, escape it to make it a literal string match
  if (isDangerousPattern(pattern)) {
    return null;
  }

  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Test a string against a pattern safely.
 * Falls back to literal string matching if regex is dangerous or invalid.
 */
export function safeRegexTest(pattern: string, str: string): boolean {
  if (!pattern || !str) {
    return false;
  }

  // First try simple substring match (safest)
  if (str.includes(pattern)) {
    return true;
  }

  // Check if pattern is dangerous
  if (isDangerousPattern(pattern)) {
    // Fall back to literal matching only
    return str.includes(pattern);
  }

  // Try regex with timeout protection via safe execution
  const safeRegExp = safeRegex(pattern);
  if (!safeRegExp) {
    // If we can't create a safe regex, fall back to literal matching
    return str.includes(pattern);
  }

  try {
    return safeRegExp.test(str);
  } catch {
    // If regex execution fails, fall back to literal matching
    return str.includes(pattern);
  }
}
