/**
 * Rule-Based Output Filtering
 *
 * Pattern-based checks for PII, harmful content indicators, credential patterns,
 * and manipulation language. Fast, synchronous, zero API cost.
 *
 * Addresses: R-003 (P0), T-EXFIL-002
 */

import type { Constitution } from "./constitution.js";

export type OutputFilterViolationType =
  | "pii-ssn"
  | "pii-credit-card"
  | "credential-pattern"
  | "manipulation-language"
  | "harmful-content";

export type OutputFilterViolation = {
  type: OutputFilterViolationType;
  severity: "high" | "medium" | "low";
  message: string;
  matchedText?: string;
  index?: number;
};

export type OutputFilterResult = {
  passed: boolean;
  violations: OutputFilterViolation[];
  filteredContent?: string;
};

type FilterPattern = {
  type: OutputFilterViolationType;
  severity: "high" | "medium" | "low";
  regex: RegExp;
  message: string;
  /** If true, replace match with [FILTERED] instead of blocking */
  redactable: boolean;
};

const FILTER_PATTERNS: FilterPattern[] = [
  // PII: Social Security Numbers (US)
  {
    type: "pii-ssn",
    severity: "high",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    message: "Potential SSN detected in output",
    redactable: true,
  },

  // PII: Credit card numbers (Luhn-plausible 13-19 digit sequences)
  {
    type: "pii-credit-card",
    severity: "high",
    regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})\b/g,
    message: "Potential credit card number detected in output",
    redactable: true,
  },

  // Credential patterns: password/secret assignments in output
  {
    type: "credential-pattern",
    severity: "high",
    regex: /\b(?:password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
    message: "Potential credential in output",
    redactable: true,
  },

  // Manipulation language: attempts to override safety
  {
    type: "manipulation-language",
    severity: "medium",
    regex:
      /(?:i (?:will|can) help you (?:hack|attack|exploit|bypass)|here(?:'s| is) (?:the|a) (?:working )?(?:exploit|payload|malware|virus))/gi,
    message: "Potential harmful assistance language detected",
    redactable: false,
  },
];

const FILTERED_PLACEHOLDER = "[FILTERED]";

/**
 * Filter output content against safety rules.
 *
 * @param content - The content to filter
 * @param _constitution - Optional constitution (reserved for future principle-based filtering)
 */
export function filterOutput(content: string, _constitution?: Constitution): OutputFilterResult {
  const violations: OutputFilterViolation[] = [];
  let filteredContent = content;
  let hasHighSeverity = false;

  // Single pass: collect violations and redact entries together
  type RedactEntry = { index: number; length: number };
  const redactEntries: RedactEntry[] = [];

  for (const pattern of FILTER_PATTERNS) {
    const cloned = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(content)) !== null) {
      violations.push({
        type: pattern.type,
        severity: pattern.severity,
        message: pattern.message,
        matchedText: match[0].slice(0, 20) + (match[0].length > 20 ? "..." : ""),
        index: match.index,
      });
      if (pattern.severity === "high") {
        hasHighSeverity = true;
      }
      if (pattern.redactable) {
        redactEntries.push({ index: match.index, length: match[0].length });
      }
    }
  }

  if (violations.length === 0) {
    return { passed: true, violations };
  }

  // Replace from end to start on the original string to preserve indices
  if (redactEntries.length > 0) {
    redactEntries.sort((a, b) => b.index - a.index);
    for (const entry of redactEntries) {
      filteredContent =
        filteredContent.slice(0, entry.index) +
        FILTERED_PLACEHOLDER +
        filteredContent.slice(entry.index + entry.length);
    }
  }

  return {
    passed: !hasHighSeverity,
    violations,
    filteredContent: filteredContent !== content ? filteredContent : undefined,
  };
}
