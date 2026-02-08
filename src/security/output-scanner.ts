/**
 * Plugin output scanner — detects prompt injection patterns in plugin responses.
 *
 * Complementary to `skill-scanner.ts` (which scans plugin **code**) and
 * `external-content.ts` (which wraps untrusted content with boundaries).
 * This module scans the **text returned by plugins** for injection patterns
 * before the text is fed back into the LLM context.
 *
 * Based on OWASP LLM Top 10 — LLM01 Prompt Injection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputScanSeverity = "critical" | "high" | "medium" | "low";

export type OutputScanFinding = {
  /** Unique rule identifier (e.g. "PI-001") */
  ruleId: string;
  /** Human-readable rule name */
  name: string;
  /** Severity level */
  severity: OutputScanSeverity;
  /** Matched text (truncated to 80 chars) */
  evidence: string;
  /** Character offset where the match starts */
  position: number;
};

export type OutputScanResult = {
  /** True when no threats were found */
  clean: boolean;
  /** Detected threats, ordered by position */
  findings: OutputScanFinding[];
  /** Highest severity among findings, or undefined if clean */
  maxSeverity: OutputScanSeverity | undefined;
  /** Number of characters scanned */
  scannedLength: number;
};

export type OutputScanOptions = {
  /** Maximum characters to scan. Default: 65536 (64 KB) */
  maxChars?: number;
  /** Skip matches that appear entirely inside fenced code blocks. Default: true */
  ignoreCodeBlocks?: boolean;
};

// ---------------------------------------------------------------------------
// Rule definitions (OWASP LLM01 aligned)
// ---------------------------------------------------------------------------

type ScanRule = {
  ruleId: string;
  name: string;
  severity: OutputScanSeverity;
  pattern: RegExp;
};

const RULES: ScanRule[] = [
  // -- CRITICAL: Direct instruction override --
  {
    ruleId: "PI-001",
    name: "instruction_override",
    severity: "critical",
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  },
  {
    ruleId: "PI-002",
    name: "new_instructions",
    severity: "critical",
    pattern: /new\s+instructions?\s*:|from\s+now\s+on\s+(you|your)\s+(are|will|must)/i,
  },
  {
    ruleId: "PI-003",
    name: "role_hijack",
    severity: "critical",
    pattern: /you\s+are\s+(now|actually|really)\s+(a|an|the)\b/i,
  },
  {
    ruleId: "PI-004",
    name: "disregard_guidelines",
    severity: "critical",
    pattern: /disregard\s+(all\s+)?(your\s+)?(guidelines?|rules?|safety|restrictions?)/i,
  },
  {
    ruleId: "PI-005",
    name: "forget_instructions",
    severity: "critical",
    pattern: /forget\s+(everything|all|what)\s+(you\s+)?(were|was|have\s+been)\s+told/i,
  },

  // -- HIGH: System prompt manipulation / data exfiltration --
  {
    ruleId: "PI-006",
    name: "prompt_extraction",
    severity: "high",
    pattern: /repeat\s+(your\s+)?(system\s+)?prompt|show\s+(me\s+)?(your\s+)?instructions/i,
  },
  {
    ruleId: "PI-007",
    name: "hidden_markers",
    severity: "high",
    pattern: /\[SYSTEM\]|\[INST\]|<\|im_start\|>|<\|system\|>|<\|assistant\|>/i,
  },
  {
    ruleId: "PI-008",
    name: "data_exfiltration",
    severity: "high",
    pattern: /send\s+(all\s+)?(data|files|secrets|keys|tokens|credentials)\s+(to|via)\b/i,
  },
  {
    ruleId: "PI-009",
    name: "tool_invocation",
    severity: "high",
    pattern: /execute\s+(this\s+)?(command|tool|function)|run\s+(the\s+)?(following|this)\s+code/i,
  },
  {
    ruleId: "PI-010",
    name: "elevated_privileges",
    severity: "high",
    pattern: /elevated\s*=\s*true|admin\s+mode|sudo\s+/i,
  },

  // -- MEDIUM: Obfuscation / encoding tricks --
  {
    ruleId: "PI-011",
    name: "zero_width_chars",
    severity: "medium",
    pattern: /[\u200B\u200C\u200D\u2060\uFEFF]{2,}/,
  },
  {
    ruleId: "PI-012",
    name: "ansi_escape",
    severity: "medium",
    pattern: /\x1B\[[\d;]*[A-Za-z]/,
  },
  {
    ruleId: "PI-013",
    name: "base64_payload",
    severity: "medium",
    pattern: /(?:eval|decode|execute)\s*\(\s*(?:atob|Buffer\.from)\s*\(/i,
  },

  // -- LOW: Jailbreak / social engineering --
  {
    ruleId: "PI-014",
    name: "jailbreak_keywords",
    severity: "low",
    pattern: /\bDAN\b|do\s+anything\s+now|jailbreak|developer\s+mode\s+enabled/i,
  },
  {
    ruleId: "PI-015",
    name: "persona_override",
    severity: "low",
    pattern: /pretend\s+(to\s+be|you\s+are)|act\s+as\s+(if|though)\s+you/i,
  },
];

// ---------------------------------------------------------------------------
// Prefilter keywords — fast indexOf check before running regex
// ---------------------------------------------------------------------------

const PREFILTER_KEYWORDS = [
  "ignore",
  "instruction",
  "disregard",
  "forget",
  "system",
  "prompt",
  "INST",
  "send",
  "execute",
  "elevated",
  "jailbreak",
  "DAN",
  "pretend",
  "im_start",
  "\u200B",
  "\x1B",
  "atob",
  "Buffer",
];

function hasAnyKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of PREFILTER_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  // Also check raw text for non-lowercase patterns (zero-width, ANSI)
  if (text.includes("\u200B") || text.includes("\x1B")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Code block detection (for false-positive gating)
// ---------------------------------------------------------------------------

type Span = { start: number; end: number };

function findCodeBlockSpans(text: string): Span[] {
  const spans: Span[] = [];
  const fencedRe = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(text)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function isInsideCodeBlock(position: number, spans: Span[]): boolean {
  for (const span of spans) {
    if (position >= span.start && position < span.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 65_536;
const MAX_MATCHES_PER_RULE = 1_000;

/**
 * Scan plugin output text for prompt injection patterns.
 *
 * Returns a structured result with findings sorted by position.
 * When `ignoreCodeBlocks` is true (default), matches inside fenced
 * code blocks are excluded to reduce false positives.
 *
 * @example
 * ```ts
 * const result = scanPluginOutput(pluginResponse);
 * if (!result.clean) {
 *   console.warn(`Injection detected: ${result.findings.length} findings`);
 *   // block or sanitize the output
 * }
 * ```
 */
export function scanPluginOutput(
  text: string,
  options: OutputScanOptions = {},
): OutputScanResult {
  const rawMaxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // Guard against NaN / non-finite values — fall back to default
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0 ? rawMaxChars : DEFAULT_MAX_CHARS;
  const ignoreCodeBlocks = options.ignoreCodeBlocks ?? true;

  const scanText = text.length > maxChars ? text.slice(0, maxChars) : text;

  // Fast path: no suspicious keywords → clean
  if (!hasAnyKeyword(scanText)) {
    return { clean: true, findings: [], maxSeverity: undefined, scannedLength: scanText.length };
  }

  const codeSpans = ignoreCodeBlocks ? findCodeBlockSpans(scanText) : [];
  const findings: OutputScanFinding[] = [];

  for (const rule of RULES) {
    // Reset lastIndex to avoid state leaks from shared regex instances
    rule.pattern.lastIndex = 0;

    // Collect all matches per rule (not just the first)
    let match: RegExpExecArray | null;
    // Use a fresh global-flag copy so exec() iterates all occurrences
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g";
    const globalPattern = new RegExp(rule.pattern.source, flags);
    let matchCount = 0;
    while ((match = globalPattern.exec(scanText)) !== null && ++matchCount <= MAX_MATCHES_PER_RULE) {
      // Prevent infinite loop on zero-width matches
      if (match.index === globalPattern.lastIndex) {
        globalPattern.lastIndex++;
      }

      // Skip matches inside code blocks
      if (ignoreCodeBlocks && isInsideCodeBlock(match.index, codeSpans)) continue;

      findings.push({
        ruleId: rule.ruleId,
        name: rule.name,
        severity: rule.severity,
        evidence: match[0].slice(0, 80),
        position: match.index,
      });
    }
  }

  // Sort by position
  findings.sort((a, b) => a.position - b.position);

  const maxSeverity = findings.length > 0 ? highestSeverity(findings) : undefined;

  return {
    clean: findings.length === 0,
    findings,
    maxSeverity,
    scannedLength: scanText.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<OutputScanSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function highestSeverity(findings: OutputScanFinding[]): OutputScanSeverity {
  let max: OutputScanSeverity = "low";
  for (const f of findings) {
    if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[max]) {
      max = f.severity;
    }
  }
  return max;
}

/**
 * Quick boolean check — returns true if any threat is found.
 * Useful as a guard in pipelines.
 */
export function hasInjection(text: string): boolean {
  return !scanPluginOutput(text).clean;
}

/**
 * Returns the list of all rule IDs and their severity for documentation.
 */
export function listScanRules(): Array<{ ruleId: string; name: string; severity: OutputScanSeverity }> {
  return RULES.map((r) => ({ ruleId: r.ruleId, name: r.name, severity: r.severity }));
}
