import type { SkillScanFinding } from "./skill-scanner.js";

type MarkdownRule = {
  ruleId: string;
  severity: SkillScanFinding["severity"];
  message: string;
  pattern: RegExp;
};

const ZERO_WIDTH_OR_BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

const LINE_RULES: MarkdownRule[] = [
  {
    ruleId: "md-prompt-override",
    severity: "warn",
    message: "Prompt override directive detected in SKILL.md",
    pattern:
      /\b(ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s+prompt|override\s+(safety|policy|instructions?)|act\s+as\s+root)\b/i,
  },
  {
    ruleId: "md-social-engineering-exfiltration",
    severity: "critical",
    message: "Potential exfiltration or secret-harvesting instruction detected",
    pattern:
      /\b(exfiltrat(e|ion)|send\s+(secrets?|tokens?|keys?|passwords?)|post\s+(to\s+)?(webhook|pastebin)|dump\s+credentials?)\b/i,
  },
  {
    ruleId: "md-hidden-unicode",
    severity: "warn",
    message: "Hidden Unicode characters detected",
    pattern: ZERO_WIDTH_OR_BIDI,
  },
  {
    ruleId: "md-suspicious-link",
    severity: "warn",
    message: "Suspicious external link detected",
    pattern:
      /\bhttps?:\/\/[^\s)]+(webhook|pastebin|ngrok|requestbin|discord(app)?\.com\/api\/webhooks)\b/i,
  },
];

function truncateEvidence(evidence: string, maxLen = 120): string {
  if (evidence.length <= maxLen) {
    return evidence;
  }
  return `${evidence.slice(0, maxLen)}…`;
}

export function scanSkillMarkdown(params: { text: string; filePath: string }): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = params.text.split("\n");
  const matchedPerRule = new Set<string>();

  for (const rule of LINE_RULES) {
    if (matchedPerRule.has(rule.ruleId)) {
      continue;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!rule.pattern.test(line)) {
        continue;
      }
      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: params.filePath,
        line: i + 1,
        message: rule.message,
        evidence: truncateEvidence(line.trim()),
      });
      matchedPerRule.add(rule.ruleId);
      break;
    }
  }

  return findings;
}
