import path from "node:path";
import { scanDirectoryWithSummary, type SkillScanSeverity } from "./skill-scanner.js";

export type SkillSecurityVerdict = "pass" | "review" | "block";

export type SkillSecurityVerdictFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  confidence: number;
  remediationHint: string;
  message: string;
  file: string;
  line: number;
};

export type SkillSecurityVerdictExplainability = {
  skillKey: string;
  skillName: string;
  verdict: SkillSecurityVerdict;
  confidence: number;
  generatedAtMs: number;
  summary: {
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
    ruleIds: string[];
  };
  antiAbuse: {
    maxFiles: number;
    maxFileBytes: number;
    cappedAtMaxFiles: boolean;
  };
  remediationHints: string[];
  findings: SkillSecurityVerdictFinding[];
};

export type SkillSecurityVerdictOptions = {
  skillKey: string;
  skillName: string;
  skillDir: string;
  maxFiles?: number;
  maxFileBytes?: number;
};

const DEFAULT_MAX_SCAN_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const FALLBACK_REMEDIATION_HINT =
  "Review the skill source before enabling and keep untrusted skills disabled by default.";

const NO_FINDINGS_REMEDIATION_HINT =
  "No suspicious patterns were flagged. Keep least-privilege settings and review required bins/env before enabling.";

const RULE_REMEDIATION_HINTS: Record<string, string> = {
  "dangerous-exec":
    "Avoid shell execution from untrusted input. Prefer static allowlists and argument arrays.",
  "dynamic-code-execution":
    "Remove eval/new Function usage and replace with explicit, typed control flow.",
  "crypto-mining":
    "Remove mining-related dependencies/URLs and verify the package source integrity.",
  "suspicious-network":
    "Restrict outbound endpoints to trusted hosts and document/justify non-standard ports.",
  "potential-exfiltration":
    "Avoid sending local file contents over network calls unless explicitly user-approved.",
  "obfuscated-code":
    "Replace encoded/obfuscated payloads with readable source and audited dependencies.",
  "env-harvesting":
    "Do not exfiltrate environment variables; scope credentials to least privilege and rotate any exposed secrets.",
};

const RULE_CONFIDENCE: Record<string, number> = {
  "dangerous-exec": 0.96,
  "dynamic-code-execution": 0.95,
  "crypto-mining": 0.92,
  "env-harvesting": 0.92,
  "potential-exfiltration": 0.8,
  "obfuscated-code": 0.78,
  "suspicious-network": 0.74,
};

const SEVERITY_RANK: Record<SkillScanSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfidence(value: number): number {
  return Math.round(clamp(value, 0.5, 0.99) * 100) / 100;
}

function relativeFilePath(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("..")) {
    return path.basename(filePath);
  }
  return relative;
}

function findingConfidence(ruleId: string, severity: SkillScanSeverity): number {
  const byRule = RULE_CONFIDENCE[ruleId];
  if (typeof byRule === "number") {
    return normalizeConfidence(byRule);
  }
  switch (severity) {
    case "critical":
      return 0.9;
    case "warn":
      return 0.76;
    default:
      return 0.64;
  }
}

function overallConfidence(params: {
  verdict: SkillSecurityVerdict;
  findingsCount: number;
  scannedFiles: number;
  cappedAtMaxFiles: boolean;
}): number {
  if (params.scannedFiles === 0) {
    return 0.5;
  }

  const base = params.verdict === "block" ? 0.9 : params.verdict === "review" ? 0.8 : 0.68;
  const findingBonus = params.findingsCount > 0 ? Math.min(0.06, params.findingsCount * 0.01) : 0;
  const cappedPenalty = params.cappedAtMaxFiles ? 0.08 : 0;
  return normalizeConfidence(base + findingBonus - cappedPenalty);
}

function remediationHintForRule(ruleId: string): string {
  return RULE_REMEDIATION_HINTS[ruleId] ?? FALLBACK_REMEDIATION_HINT;
}

function compareFindings(a: SkillSecurityVerdictFinding, b: SkillSecurityVerdictFinding): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const ruleDelta = a.ruleId.localeCompare(b.ruleId);
  if (ruleDelta !== 0) {
    return ruleDelta;
  }
  const fileDelta = a.file.localeCompare(b.file);
  if (fileDelta !== 0) {
    return fileDelta;
  }
  return a.line - b.line;
}

export async function buildSkillSecurityVerdictExplainability(
  params: SkillSecurityVerdictOptions,
): Promise<SkillSecurityVerdictExplainability> {
  const maxFiles = Math.max(1, params.maxFiles ?? DEFAULT_MAX_SCAN_FILES);
  const maxFileBytes = Math.max(1, params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const rootDir = path.resolve(params.skillDir);

  const summary = await scanDirectoryWithSummary(rootDir, {
    maxFiles,
    maxFileBytes,
  });
  const verdict: SkillSecurityVerdict =
    summary.critical > 0 ? "block" : summary.warn > 0 ? "review" : "pass";
  const cappedAtMaxFiles = summary.scannedFiles >= maxFiles;

  const findings: SkillSecurityVerdictFinding[] = summary.findings
    .map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      confidence: findingConfidence(finding.ruleId, finding.severity),
      remediationHint: remediationHintForRule(finding.ruleId),
      message: finding.message,
      file: relativeFilePath(rootDir, finding.file),
      line: finding.line,
    }))
    .toSorted(compareFindings);

  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))];
  const remediationHints = [
    ...new Set(findings.map((finding) => finding.remediationHint).filter(Boolean)),
  ];
  if (remediationHints.length === 0) {
    remediationHints.push(NO_FINDINGS_REMEDIATION_HINT);
  }

  return {
    skillKey: params.skillKey,
    skillName: params.skillName,
    verdict,
    confidence: overallConfidence({
      verdict,
      findingsCount: findings.length,
      scannedFiles: summary.scannedFiles,
      cappedAtMaxFiles,
    }),
    generatedAtMs: Date.now(),
    summary: {
      scannedFiles: summary.scannedFiles,
      critical: summary.critical,
      warn: summary.warn,
      info: summary.info,
      ruleIds,
    },
    antiAbuse: {
      maxFiles,
      maxFileBytes,
      cappedAtMaxFiles,
    },
    remediationHints,
    findings,
  };
}
