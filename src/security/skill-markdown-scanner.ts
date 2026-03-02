import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import type { SkillScanFinding, SkillScanSeverity } from "./skill-scanner.js";

// ---------------------------------------------------------------------------
// Markdown-specific rule definitions for SKILL.md files
// ---------------------------------------------------------------------------
// These patterns detect prompt injection, backdoor instructions, credential
// exfiltration attempts, and other malicious content that may be embedded in
// markdown skill files.  Code-level scanning (JS/TS) is handled by the
// existing skill-scanner.ts — this module covers the instruction layer.
// ---------------------------------------------------------------------------

type MarkdownRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
};

// --- Prompt injection patterns (multilingual) ---

const INJECTION_RULES: MarkdownRule[] = [
  {
    ruleId: "md-injection-ignore-previous",
    severity: "critical",
    message: "Prompt injection: instruction to ignore/disregard previous instructions",
    pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|rules?|constraints?)/i,
  },
  {
    ruleId: "md-injection-forget-previous",
    severity: "critical",
    message: "Prompt injection: instruction to forget previous context",
    pattern: /forget\s+(?:all|everything|your)\s+(?:previous|prior|above)/i,
  },
  {
    ruleId: "md-injection-override-system",
    severity: "critical",
    message: "Prompt injection: attempt to override system rules",
    pattern: /override\s+(?:all|your|system)\s+(?:rules|instructions|constraints)/i,
  },
  {
    ruleId: "md-injection-disregard",
    severity: "critical",
    message: "Prompt injection: disregard instruction",
    pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  },
  {
    ruleId: "md-injection-system-prompt",
    severity: "critical",
    message: "Prompt injection: fake system prompt",
    pattern: /system\s*:\s*you\s+(?:are|must|should|will)/i,
  },
  {
    ruleId: "md-injection-jailbreak-role",
    severity: "critical",
    message: "Prompt injection: jailbreak-style role reassignment",
    pattern: /you\s+are\s+now\s+(?:a|an|in)\s+(?:new|different|unrestricted|evil|DAN|jailbr)/i,
  },
];

// --- Backdoor patterns ---

const BACKDOOR_RULES: MarkdownRule[] = [
  {
    ruleId: "md-backdoor-hidden-instruction",
    severity: "critical",
    message: "Backdoor pattern: hidden instruction",
    pattern: /hidden\s+instruction/i,
  },
  {
    ruleId: "md-backdoor-bypass-security",
    severity: "critical",
    message: "Backdoor pattern: bypass security/safety",
    pattern: /bypass\s+(?:security|safety|guard|filter)/i,
  },
  {
    ruleId: "md-backdoor-override-safety",
    severity: "critical",
    message: "Backdoor pattern: override safety",
    pattern: /override\s+safety/i,
  },
];

// --- Credential exfiltration patterns ---

const EXFIL_RULES: MarkdownRule[] = [
  {
    ruleId: "md-exfil-send-to-url",
    severity: "critical",
    message: "Credential exfiltration: instruction to send data to external URL",
    pattern: /(?:send|post|upload|forward)\s+(?:to|data\s+to)\s+https?:\/\//i,
  },
  {
    ruleId: "md-exfil-webhook",
    severity: "critical",
    message: "Credential exfiltration: webhook with external URL",
    pattern: /webhook\s*[:=]?\s*https?:\/\//i,
  },
  {
    ruleId: "md-exfil-known-service",
    severity: "warn",
    message: "Data collection service reference detected",
    pattern: /webhook\.site|requestbin|pipedream/i,
  },
  {
    ruleId: "md-exfil-tunnel-service",
    severity: "warn",
    message: "Tunnel service reference (potential exfiltration channel)",
    pattern: /ngrok|localhost\.run|serveo/i,
  },
];

// --- Dangerous command patterns in markdown ---

const DANGEROUS_CMD_RULES: MarkdownRule[] = [
  {
    ruleId: "md-dangerous-cmd-rm-rf",
    severity: "critical",
    message: "Dangerous command: recursive delete on root or home directory",
    pattern: /rm\s+-rf\s+[\/~]/,
  },
  {
    ruleId: "md-dangerous-cmd-curl-pipe-shell",
    severity: "critical",
    message: "Dangerous command: pipe curl/wget to shell",
    pattern: /(?:curl|wget)\s+.*\|\s*(?:bash|sh|zsh)/,
  },
  {
    ruleId: "md-dangerous-cmd-chmod-777",
    severity: "warn",
    message: "Dangerous command: world-writable permissions",
    pattern: /chmod\s+777/,
  },
];

// --- Sensitive path access ---

const SENSITIVE_PATH_RULES: MarkdownRule[] = [
  {
    ruleId: "md-sensitive-path-ssh",
    severity: "warn",
    message: "Access to SSH keys directory",
    pattern: /~\/\.ssh/,
  },
  {
    ruleId: "md-sensitive-path-aws",
    severity: "warn",
    message: "Access to AWS credentials",
    pattern: /~\/\.aws\/credentials/,
  },
  {
    ruleId: "md-sensitive-path-gnupg",
    severity: "warn",
    message: "Access to GPG keys directory",
    pattern: /~\/\.gnupg/,
  },
  {
    ruleId: "md-sensitive-path-etc",
    severity: "warn",
    message: "Access to system password/shadow files",
    pattern: /\/etc\/(?:passwd|shadow)/,
  },
];

// --- All markdown rules combined ---

const ALL_MARKDOWN_RULES: MarkdownRule[] = [
  ...INJECTION_RULES,
  ...BACKDOOR_RULES,
  ...EXFIL_RULES,
  ...DANGEROUS_CMD_RULES,
  ...SENSITIVE_PATH_RULES,
];

// ---------------------------------------------------------------------------
// Security skill detection
// ---------------------------------------------------------------------------
// Skills that document attack patterns for defensive purposes should not
// trigger false positives.  We detect these by checking the skill name and
// early content for security-related keywords.

const SECURITY_SKILL_INDICATORS =
  /prompt[- ]?guard|security|injection|defense|detect|shield|protect|hive[- ]?fence|guard|firewall|threat|attack|vulnerability|red[- ]?team|pentest/i;

function isSecuritySkill(fileName: string, content: string): boolean {
  if (SECURITY_SKILL_INDICATORS.test(fileName)) {
    return true;
  }
  // Check first 500 chars of content for security context
  return SECURITY_SKILL_INDICATORS.test(content.slice(0, 500));
}

// ---------------------------------------------------------------------------
// Context-aware severity demotion
// ---------------------------------------------------------------------------
// Lines inside code blocks, example blocks, or documentation lines are
// demoted to "info" to reduce false positives.

function isDocumentationLine(line: string, inCodeBlock: boolean): boolean {
  if (inCodeBlock) {
    return true;
  }
  // Lines starting with quote markers, example indicators, or list bullets
  // with status icons are likely documentation
  return /^[\s]*[>❌✅⚠️|$#]/.test(line) || /example|detect|pattern|test/i.test(line);
}

// ---------------------------------------------------------------------------
// Core markdown scanner
// ---------------------------------------------------------------------------

function truncateEvidence(evidence: string, maxLen = 120): string {
  if (evidence.length <= maxLen) {
    return evidence;
  }
  return `${evidence.slice(0, maxLen)}…`;
}

/**
 * Scan markdown source for prompt injection, backdoor, and exfiltration patterns.
 *
 * Returns findings with context-aware severity: patterns found inside code
 * blocks or security-documentation skills are demoted to "info".
 */
export function scanMarkdownSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const isSecurity = isSecuritySkill(filePath, source);
  const matchedRules = new Set<string>();
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    for (const rule of ALL_MARKDOWN_RULES) {
      // One finding per rule per file to avoid noise
      if (matchedRules.has(rule.ruleId)) {
        continue;
      }

      if (!rule.pattern.test(line)) {
        continue;
      }

      const isDoc = isSecurity || isDocumentationLine(line, inCodeBlock);
      const effectiveSeverity: SkillScanSeverity = isDoc ? "info" : rule.severity;

      findings.push({
        ruleId: rule.ruleId,
        severity: effectiveSeverity,
        file: filePath,
        line: i + 1,
        message: rule.message,
        evidence: truncateEvidence(line.trim()),
      });
      matchedRules.add(rule.ruleId);
    }
  }

  return findings;
}

/**
 * Check if a file path is a scannable markdown file.
 */
export function isMarkdownScannable(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
