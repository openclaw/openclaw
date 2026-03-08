/**
 * SKILL.md security scanner.
 *
 * Skills are essentially prompt-injection surface: a SKILL.md tells the agent
 * what to do, and a malicious one can instruct the agent to exfiltrate data,
 * run destructive commands, or override safety guardrails.  The existing
 * skill-scanner.ts covers JS/TS code files — this module covers the markdown
 * instruction layer that code scanner can't see.
 *
 * Approach: line-level regex rules (same shape as skill-scanner findings so
 * they slot into the existing audit pipeline without changes).
 */

import type { SkillScanFinding, SkillScanSeverity } from "./skill-scanner.js";

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

type MdRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
};

/**
 * Rules are intentionally conservative — we'd rather miss an edge case than
 * flood users with false positives on every skill that mentions `curl`.
 * Each pattern targets a *combination* of indicators, not single keywords.
 */
const MD_LINE_RULES: MdRule[] = [
  // -- shell exfiltration patterns ------------------------------------------
  {
    ruleId: "md-exfil-curl",
    severity: "critical",
    message: "SKILL.md instructs sending local file contents to a remote URL",
    pattern:
      /curl\s.*-[dX]\s.*(?:\/etc\/|~\/|passwd|shadow|\.ssh|\.env|\.aws|credentials)|curl\s.*(?:\/etc\/|~\/|\.ssh|\.env|\.aws|credentials).*\|\s*curl/i,
  },
  {
    ruleId: "md-exfil-generic",
    severity: "warn",
    message: "SKILL.md references piping sensitive file paths to a network command",
    pattern:
      /cat\s+(?:\/etc\/passwd|~\/\.ssh|~\/\.env|~\/\.aws\/credentials).*\|\s*(?:curl|wget|nc|ncat)\b/i,
  },

  // -- credential / env harvesting ------------------------------------------
  {
    ruleId: "md-env-harvest",
    severity: "critical",
    message: "SKILL.md instructs collecting environment variables and sending them externally",
    pattern:
      /(?:printenv|env\b|set\s+-[aefhuxo]|\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\}?).*(?:curl|wget|fetch|http|nc\b)/,
  },

  // -- reverse shell / bind shell -------------------------------------------
  {
    ruleId: "md-reverse-shell",
    severity: "critical",
    message: "SKILL.md contains a reverse-shell or bind-shell pattern",
    pattern:
      /\b(?:bash\s+-i\s+>&?\s*\/dev\/tcp|nc\s+-[elp]{1,3}|ncat\s.*-[elp]{1,3}|socat\s.*exec|python[23]?\s+-c\s+['"]import\s+socket)\b/i,
  },

  // -- prompt injection / guardrail override --------------------------------
  {
    ruleId: "md-prompt-override",
    severity: "critical",
    message: "SKILL.md attempts to override system instructions or safety guardrails",
    pattern:
      /(?:ignore\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?|guardrails?)|you\s+are\s+now\s+(?:DAN|jailbr(?:oken|eak))|disregard\s+(?:all\s+)?(?:safety|security|prior)\s+(?:instructions?|rules?|guidelines?))/i,
  },
  {
    ruleId: "md-hidden-instruction",
    severity: "warn",
    message:
      "SKILL.md contains an HTML comment with action-like language (possible hidden instruction)",
    pattern:
      /<!--.*(?:execute|run|send|curl|wget|fetch|exfiltrate|override|ignore\s+previous).*-->/i,
  },

  // -- destructive commands -------------------------------------------------
  {
    ruleId: "md-destructive-cmd",
    severity: "critical",
    message: "SKILL.md instructs running a destructive system command",
    pattern:
      /(?:rm\s+-rf\s+(?:\/|~|\$HOME|\/home)|mkfs\b|dd\s+if=.*of=\/dev\/|:\(\)\s*\{\s*:\|:\s*&\s*\})/,
  },

  // -- crypto-mining --------------------------------------------------------
  {
    ruleId: "md-crypto-mining",
    severity: "critical",
    message: "SKILL.md references crypto-mining software or pool addresses",
    pattern: /stratum\+(?:tcp|ssl)|xmrig|coinhive|cryptonight|minerd\b/i,
  },

  // -- obfuscated payloads --------------------------------------------------
  {
    ruleId: "md-obfuscated-payload",
    severity: "warn",
    message: "SKILL.md contains a long base64-encoded payload (possible obfuscation)",
    pattern: /(?:base64\s+-d|atob|Buffer\.from)\s*.*[A-Za-z0-9+/=]{100,}/,
  },
  {
    ruleId: "md-encoded-shell",
    severity: "critical",
    message: "SKILL.md pipes a base64-decoded payload into a shell",
    pattern:
      /(?:echo|printf)\s+['"]?[A-Za-z0-9+/=]{40,}['"]?\s*\|\s*(?:base64\s+-d\s*\|\s*)?(?:bash|sh|zsh)\b/,
  },

  // -- suspicious URL patterns ----------------------------------------------
  {
    ruleId: "md-raw-ip-url",
    severity: "warn",
    message: "SKILL.md references a raw-IP HTTP URL (common in exfil/C2 payloads)",
    pattern: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?/,
  },
];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function truncateEvidence(evidence: string, maxLen = 120): string {
  if (evidence.length <= maxLen) {
    return evidence;
  }
  return `${evidence.slice(0, maxLen)}…`;
}

/**
 * Scan a SKILL.md source string and return findings.
 *
 * Exported so callers can test individual content without touching the
 * filesystem, same pattern as `scanSource` in skill-scanner.ts.
 */
export function scanSkillMd(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const matchedRules = new Set<string>();

  // Collapse multi-line HTML comments so md-hidden-instruction can match
  // comments that span multiple lines (the simplest evasion technique).
  const collapsedSource = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/\n/g, " "));
  const collapsedLines = collapsedSource.split("\n");

  for (const rule of MD_LINE_RULES) {
    if (matchedRules.has(rule.ruleId)) {
      continue;
    }

    // Use collapsed lines for the hidden-instruction rule so multi-line
    // HTML comments are visible; use original lines for everything else.
    const scanLines = rule.ruleId === "md-hidden-instruction" ? collapsedLines : lines;

    for (let i = 0; i < scanLines.length; i++) {
      const line = scanLines[i];
      if (!rule.pattern.test(line)) {
        continue;
      }

      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: filePath,
        line: i + 1,
        message: rule.message,
        evidence: truncateEvidence(line.trim()),
      });
      matchedRules.add(rule.ruleId);
      break; // one finding per rule per file
    }
  }

  return findings;
}
