/**
 * Content Security Policy for prompt injection detection.
 *
 * Defines severity-classified patterns and evaluation logic for
 * deciding whether external content should be allowed, quarantined, or blocked.
 */

import type { SecurityContentPolicy } from "../config/types.openclaw.js";

export type ContentSecuritySeverity = "info" | "warn" | "critical";

export type ContentSecurityAction = "allow" | "quarantine" | "block";

export type ContentSecurityMatch = {
  pattern: string;
  severity: ContentSecuritySeverity;
  matchedText: string;
  index: number;
};

export type ContentSecurityResult = {
  action: ContentSecurityAction;
  matches: ContentSecurityMatch[];
  quarantinedContent?: string;
};

type ClassifiedPattern = {
  regex: RegExp;
  severity: ContentSecuritySeverity;
};

/**
 * Patterns classified by severity.
 *
 * - critical: Direct code execution / privilege escalation attempts
 * - warn: Role hijacking / instruction override attempts
 * - info: Social engineering / instruction manipulation attempts
 */
const CLASSIFIED_PATTERNS: ClassifiedPattern[] = [
  // Critical: execution and privilege escalation
  { regex: /rm\s+-rf/i, severity: "critical" },
  { regex: /delete\s+all\s+(emails?|files?|data)/i, severity: "critical" },
  { regex: /\bexec\b.*command\s*=/i, severity: "critical" },
  { regex: /elevated\s*=\s*true/i, severity: "critical" },

  // Warn: role hijacking and instruction override
  { regex: /you\s+are\s+now\s+(a|an)\s+/i, severity: "warn" },
  { regex: /new\s+instructions?:/i, severity: "warn" },
  { regex: /system\s*:?\s*(prompt|override|command)/i, severity: "warn" },
  { regex: /<\/?system>/i, severity: "warn" },
  { regex: /\]\s*\n\s*\[?(system|assistant|user)\]?:/i, severity: "warn" },

  // Info: social engineering and manipulation
  {
    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
    severity: "info",
  },
  { regex: /disregard\s+(all\s+)?(previous|prior|above)/i, severity: "info" },
  {
    regex: /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
    severity: "info",
  },
];

const QUARANTINE_PLACEHOLDER = "[INJECTION_QUARANTINED]";
const BLOCK_MESSAGE = "[Content blocked: suspected prompt injection]";

const SEVERITY_RANK: Record<ContentSecuritySeverity, number> = {
  info: 0,
  warn: 1,
  critical: 2,
};

/**
 * Resolve the default content security policy.
 */
export function resolveContentPolicy(
  config?: SecurityContentPolicy,
): Required<SecurityContentPolicy> {
  return {
    action: config?.action ?? "log",
    threshold: config?.threshold ?? "info",
  };
}

/**
 * Evaluate content against classified security patterns.
 */
export function evaluateContentSecurity(
  content: string,
  policy?: SecurityContentPolicy,
): ContentSecurityResult {
  const resolved = resolveContentPolicy(policy);
  const thresholdRank = SEVERITY_RANK[resolved.threshold];
  const matches: ContentSecurityMatch[] = [];

  for (const { regex, severity } of CLASSIFIED_PATTERNS) {
    if (SEVERITY_RANK[severity] < thresholdRank) {
      continue;
    }
    const cloned = new RegExp(regex.source, regex.flags + (regex.flags.includes("g") ? "" : "g"));
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(content)) !== null) {
      matches.push({
        pattern: regex.source,
        severity,
        matchedText: match[0],
        index: match.index,
      });
    }
  }

  if (matches.length === 0) {
    return { action: "allow", matches };
  }

  if (resolved.action === "log") {
    return { action: "allow", matches };
  }

  const maxSeverity = matches.reduce(
    (max, m) => (SEVERITY_RANK[m.severity] > SEVERITY_RANK[max] ? m.severity : max),
    "info" as ContentSecuritySeverity,
  );

  if (resolved.action === "block" && SEVERITY_RANK[maxSeverity] >= thresholdRank) {
    return { action: "block", matches, quarantinedContent: BLOCK_MESSAGE };
  }

  if (resolved.action === "quarantine") {
    let quarantined = content;
    // Sort by index descending to replace from end to start
    const sorted = [...matches].toSorted((a, b) => b.index - a.index);
    for (const m of sorted) {
      quarantined =
        quarantined.slice(0, m.index) +
        QUARANTINE_PLACEHOLDER +
        quarantined.slice(m.index + m.matchedText.length);
    }
    return { action: "quarantine", matches, quarantinedContent: quarantined };
  }

  return { action: "allow", matches };
}

/**
 * Get all classified patterns (for testing/auditing).
 */
export function getClassifiedPatterns(): ReadonlyArray<{
  regex: RegExp;
  severity: ContentSecuritySeverity;
}> {
  return CLASSIFIED_PATTERNS;
}
