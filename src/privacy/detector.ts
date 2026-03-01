/**
 * Privacy detection engine — scans text for sensitive information.
 * Ported from the Python PrivacyFilter with TypeScript regex engine.
 */

import { EXTENDED_RULES, resolveRules } from "./rules.js";
import type { DetectionMatch, FilterResult, PrivacyRule, RiskLevel } from "./types.js";

const CONTEXT_WINDOW = 50;

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

// ─── Password complexity & entropy validators ───

/**
 * Check if a string meets common password complexity requirements.
 * Requires at least 3 of 4 character classes: uppercase, lowercase, digit, special.
 */
export function isPasswordLikeComplexity(s: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(s)) {
    classes++;
  }
  if (/[A-Z]/.test(s)) {
    classes++;
  }
  if (/[0-9]/.test(s)) {
    classes++;
  }
  if (/[^a-zA-Z0-9]/.test(s)) {
    classes++;
  }
  return classes >= 3;
}

/**
 * Calculate Shannon entropy (bits per character) of a string.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Minimum Shannon entropy (bits/char) to consider a string high-entropy. */
const HIGH_ENTROPY_THRESHOLD = 3.5;

// Common words/patterns that look like passwords but aren't.
const FALSE_POSITIVE_PATTERNS = [
  /^https?:\/\//i, // URLs
  /^[a-z]+[-_][a-z]+$/i, // kebab-case / snake_case identifiers
  /^\w+\.\w+\.\w+$/, // dotted identifiers like package.module.Class
  /^\/[\w/]+$/, // file paths
];

/**
 * Validate a bare password candidate: must have password-like complexity
 * and not match common false-positive patterns.
 */
export function validateBarePassword(s: string): boolean {
  // Too short or too long to be a realistic bare password.
  if (s.length < 8 || s.length > 64) {
    return false;
  }

  // Skip if it matches common non-password patterns.
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(s)) {
      return false;
    }
  }

  return isPasswordLikeComplexity(s);
}

/**
 * Validate a high-entropy string: must exceed the entropy threshold
 * and not be a simple sequential/patterned string.
 */
export function validateHighEntropy(s: string): boolean {
  if (s.length < 16) {
    return false;
  }
  const entropy = shannonEntropy(s);
  if (entropy < HIGH_ENTROPY_THRESHOLD) {
    return false;
  }

  // Reject sequential character runs (e.g. "abcdefghijklmnop", "1234567890").
  if (isSequentialString(s)) {
    return false;
  }

  return true;
}

/**
 * Check if a string is mostly sequential characters (alphabetical or numeric runs).
 * Returns true if >60% of adjacent pairs are sequential.
 */
function isSequentialString(s: string): boolean {
  if (s.length < 4) {
    return false;
  }
  let sequential = 0;
  for (let i = 1; i < s.length; i++) {
    const diff = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (diff === 1 || diff === -1) {
      sequential++;
    }
  }
  return sequential / (s.length - 1) > 0.6;
}

/** Compiled rule — caches compiled regex patterns per rule. */
interface CompiledRule {
  rule: PrivacyRule;
  patterns: RegExp[];
  keywordPatterns: RegExp[];
}

export class PrivacyDetector {
  private compiledRules: CompiledRule[] = [];
  private enabled: boolean = true;

  constructor(rules?: PrivacyRule[] | string) {
    const ruleSet = typeof rules === "string" ? resolveRules(rules) : (rules ?? EXTENDED_RULES);
    this.loadRules(ruleSet);
  }

  private loadRules(rules: PrivacyRule[]): void {
    this.compiledRules = [];
    for (const rule of rules) {
      if (!rule.enabled) {
        continue;
      }
      const compiled: CompiledRule = {
        rule,
        patterns: [],
        keywordPatterns: [],
      };

      if (rule.pattern) {
        const re = this.compilePattern(rule.pattern);
        if (re) {
          compiled.patterns.push(re);
        }
      }

      if (rule.keywords) {
        for (const kw of rule.keywords) {
          const flags = rule.caseSensitive ? "g" : "gi";
          compiled.keywordPatterns.push(new RegExp(escapeRegex(kw), flags));
        }
      }

      compiled.patterns.push(...compiled.keywordPatterns);
      if (compiled.patterns.length > 0) {
        this.compiledRules.push(compiled);
      }
    }
  }

  private compilePattern(pattern: string): RegExp | null {
    try {
      // Handle (?i) inline flag — JS doesn't support it, convert to flag.
      let flags = "gm";
      let src = pattern;
      if (src.startsWith("(?i)")) {
        src = src.slice(4);
        flags += "i";
      }
      return new RegExp(src, flags);
    } catch {
      return null;
    }
  }

  /** Detect all privacy matches in the given text. */
  detect(text: string): FilterResult {
    if (!this.enabled || !text) {
      return {
        hasPrivacyRisk: false,
        matches: [],
        riskCount: {},
        highestRiskLevel: null,
      };
    }

    const allMatches: DetectionMatch[] = [];

    for (const compiled of this.compiledRules) {
      const matches = this.checkRule(text, compiled);
      allMatches.push(...matches);
    }

    const unique = this.deduplicateMatches(allMatches);

    const riskCount: Record<string, number> = {};
    for (const m of unique) {
      riskCount[m.type] = (riskCount[m.type] ?? 0) + 1;
    }

    return {
      hasPrivacyRisk: unique.length > 0,
      matches: unique,
      riskCount,
      highestRiskLevel: this.getHighestRisk(unique),
    };
  }

  /** Simple boolean check — does the text contain privacy risks? */
  check(text: string): boolean {
    return this.detect(text).hasPrivacyRisk;
  }

  private checkRule(text: string, compiled: CompiledRule): DetectionMatch[] {
    const matches: DetectionMatch[] = [];
    const { rule } = compiled;

    // Regex pattern matching
    if (rule.pattern && compiled.patterns.length > 0) {
      const re = compiled.patterns[0];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (this.checkContext(text, m.index, m.index + m[0].length, rule)) {
          // Run optional post-match validator.
          if (!rule.validate || rule.validate(m[0])) {
            matches.push({
              type: rule.type,
              content: m[0],
              start: m.index,
              end: m.index + m[0].length,
              riskLevel: rule.riskLevel,
              description: rule.description,
              replacementTemplate: rule.replacementTemplate,
            });
          }
        }
        // Prevent infinite loops for zero-length matches
        if (m[0].length === 0) {
          re.lastIndex++;
        }
      }
    }

    // Keyword matching (only if no pattern, or separate keyword entries)
    if (rule.keywords && !rule.pattern) {
      for (const kwRe of compiled.keywordPatterns) {
        kwRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = kwRe.exec(text)) !== null) {
          if (this.checkContext(text, m.index, m.index + m[0].length, rule)) {
            matches.push({
              type: rule.type,
              content: m[0],
              start: m.index,
              end: m.index + m[0].length,
              riskLevel: rule.riskLevel,
              description: rule.description,
              replacementTemplate: rule.replacementTemplate,
            });
          }
          if (m[0].length === 0) {
            kwRe.lastIndex++;
          }
        }
      }
    }

    return matches;
  }

  private checkContext(text: string, start: number, end: number, rule: PrivacyRule): boolean {
    const ctx = rule.context;
    if (!ctx) {
      return true;
    }

    const ctxStart = Math.max(0, start - CONTEXT_WINDOW);
    const ctxEnd = Math.min(text.length, end + CONTEXT_WINDOW);
    const context = text.slice(ctxStart, ctxEnd).toLowerCase();

    if (ctx.mustContain) {
      // At least one of the context keywords must appear nearby.
      const found = ctx.mustContain.some((kw) => context.includes(kw.toLowerCase()));
      if (!found) {
        return false;
      }
    }

    if (ctx.mustNotContain) {
      for (const kw of ctx.mustNotContain) {
        if (context.includes(kw.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  }

  private deduplicateMatches(matches: DetectionMatch[]): DetectionMatch[] {
    const seen = new Set<string>();
    const unique: DetectionMatch[] = [];

    for (const m of matches) {
      const key = `${m.start}:${m.end}:${m.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(m);
      }
    }

    return unique.toSorted((a, b) => a.start - b.start);
  }

  private getHighestRisk(matches: DetectionMatch[]): RiskLevel | null {
    if (matches.length === 0) {
      return null;
    }
    let highest: DetectionMatch = matches[0];
    for (const m of matches) {
      if (RISK_ORDER[m.riskLevel] > RISK_ORDER[highest.riskLevel]) {
        highest = m;
      }
    }
    return highest.riskLevel;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
