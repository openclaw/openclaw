/**
 * Pattern Matcher Utilities
 *
 * Utilities for matching noise patterns, separators, and boundaries in terminal output.
 * Optimized for performance with regex caching.
 */

import type { NoisePattern } from "./types.js";
import { getChildLogger } from "../../logging/logger.js";

const logger = getChildLogger({ module: "pattern-matcher" });

/**
 * Pattern matcher with compiled regex caching for performance
 */
export class PatternMatcher {
  private readonly compiledRegexes: Map<string, RegExp> = new Map();

  constructor(private readonly patterns: NoisePattern[]) {
    // Pre-compile all regex patterns for performance
    let successCount = 0;
    let failCount = 0;

    for (const pattern of patterns) {
      if (pattern.type === "regex" && pattern.pattern) {
        try {
          this.compiledRegexes.set(pattern.pattern, new RegExp(pattern.pattern));
          successCount++;
        } catch (error) {
          logger.warn("regex_compilation_failed", {
            pattern: pattern.pattern,
            patternType: pattern.type,
            error: error instanceof Error ? error.message : String(error),
          });
          failCount++;
        }
      }
    }

    logger.debug("pattern_matcher_initialized", {
      totalPatterns: patterns.length,
      regexPatternsCompiled: successCount,
      compilationFailures: failCount,
    });
  }

  /**
   * Check if a line matches the given noise pattern
   */
  matches(line: string, pattern: NoisePattern): boolean {
    switch (pattern.type) {
      case "prefix":
        return this.matchesPrefix(line, pattern.value || "");
      case "regex":
        return this.matchesRegex(line, pattern.pattern || "");
      case "separator":
        return this.isSeparatorLine(line, pattern.chars);
      case "context_hint":
        // Context hints are treated like regex patterns
        return this.matchesRegex(line, pattern.pattern || "");
      default:
        return false;
    }
  }

  /**
   * Check if line matches any of the configured patterns
   */
  matchesAny(line: string): boolean {
    return this.patterns.some((pattern) => this.matches(line, pattern));
  }

  /**
   * Check if line starts with the given prefix (after trimming leading whitespace)
   */
  private matchesPrefix(line: string, prefix: string): boolean {
    if (!prefix) return false;
    return line.trimStart().startsWith(prefix);
  }

  /**
   * Check if line matches the regex pattern (using cached compiled regex)
   */
  private matchesRegex(line: string, pattern: string): boolean {
    if (!pattern) return false;

    const regex = this.compiledRegexes.get(pattern);
    if (!regex) {
      // Pattern wasn't pre-compiled (shouldn't happen, but handle gracefully)
      try {
        return new RegExp(pattern).test(line);
      } catch {
        return false;
      }
    }

    return regex.test(line);
  }

  /**
   * Check if line is a separator (all same symbol character)
   */
  private isSeparatorLine(line: string, chars?: string): boolean {
    const stripped = line.trim();
    if (!stripped) return false;

    // If specific separator chars provided, check if line uses them
    const separatorChars = chars || "─═-_";

    // Line must be at least 3 chars (avoid matching single symbols)
    if (stripped.length < 3) return false;

    // All characters must be the same separator character
    const firstChar = stripped[0];
    if (!separatorChars.includes(firstChar)) return false;

    return stripped.split("").every((char) => char === firstChar);
  }
}

/**
 * Utility functions for pattern matching
 */
export class PatternUtils {
  /**
   * Check if line is a separator line (static version)
   */
  static isSeparatorLine(line: string, chars?: string): boolean {
    const stripped = line.trim();
    if (!stripped || stripped.length < 3) return false;

    const separatorChars = chars || "─═-_";
    const firstChar = stripped[0];

    if (!separatorChars.includes(firstChar)) return false;
    return stripped.split("").every((char) => char === firstChar);
  }

  /**
   * Remove response marker and optional content from line
   */
  static stripMarkerAndEcho(line: string, marker: string, echoPattern?: string): string {
    let cleaned = line.trimStart();

    // Remove response marker
    if (cleaned.startsWith(marker)) {
      cleaned = cleaned.slice(marker.length).trimStart();
    }

    // Remove echo content if pattern provided
    if (echoPattern && cleaned) {
      try {
        cleaned = cleaned.replace(new RegExp(echoPattern), "").trim();
      } catch (error) {
        // Invalid regex pattern, skip echo removal
        logger.warn("invalid_echo_pattern", {
          echoPattern,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return cleaned;
  }

  /**
   * Check if line starts with any of the given prefixes
   */
  static startsWithAny(line: string, prefixes: string[]): boolean {
    const trimmed = line.trimStart();
    return prefixes.some((prefix) => trimmed.startsWith(prefix));
  }
}
