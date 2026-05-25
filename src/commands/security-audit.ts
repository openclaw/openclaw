import { homedir } from "node:os";
import type { RuntimeEnv } from "../runtime.js";
import { scanCredentials } from "./security-audit/credential-scanner.js";
import { auditNetwork } from "./security-audit/network-audit.js";
import { auditPermissions } from "./security-audit/permission-audit.js";
import type {
  SecurityAuditOptions,
  SecurityAuditResult,
  SecurityFinding,
  SecuritySeverity,
} from "./security-audit/types.js";

const SEVERITY_ORDER: SecuritySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function severityRank(severity: SecuritySeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function shouldIncludeFinding(finding: SecurityFinding, minSeverity?: SecuritySeverity): boolean {
  if (!minSeverity) return true;
  return severityRank(finding.severity) <= severityRank(minSeverity);
}

export async function securityAuditCommand(
  runtime: RuntimeEnv,
  options: SecurityAuditOptions = {},
): Promise<SecurityAuditResult> {
  const homeDir = homedir();
  const allFindings: SecurityFinding[] = [];
  const scannedPaths: string[] = [];

  if (options.includeCredentials !== false) {
    const credFindings = await scanCredentials(homeDir);
    allFindings.push(...credFindings);
    scannedPaths.push(`${homeDir}/.openclaw/*`, `${homeDir}/.ssh/*`);
  }

  if (options.includePermissions !== false) {
    const permFindings = await auditPermissions(homeDir);
    allFindings.push(...permFindings);
    scannedPaths.push(`${homeDir}/.openclaw/*`, `${homeDir}/.ssh/*`);
  }

  if (options.includeNetwork !== false) {
    const netFindings = await auditNetwork();
    allFindings.push(...netFindings);
    scannedPaths.push("network listeners");
  }

  const filteredFindings = allFindings.filter((f) => shouldIncludeFinding(f, options.severityMin));

  // Sort by severity (most severe first)
  filteredFindings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const result: SecurityAuditResult = {
    findings: filteredFindings,
    summary: {
      critical: filteredFindings.filter((f) => f.severity === "CRITICAL").length,
      high: filteredFindings.filter((f) => f.severity === "HIGH").length,
      medium: filteredFindings.filter((f) => f.severity === "MEDIUM").length,
      low: filteredFindings.filter((f) => f.severity === "LOW").length,
      total: filteredFindings.length,
    },
    scannedPaths: [...new Set(scannedPaths)],
  };

  if (options.json) {
    runtime.writeRuntimeJson?.(result);
  } else {
    emitSecurityAuditReport(runtime, result);
  }

  return result;
}

function emitSecurityAuditReport(runtime: RuntimeEnv, result: SecurityAuditResult): void {
  const { info, error, warning } = runtime;

  info?.("🔒 OpenClaw Security Audit");
  info?.("");

  if (result.findings.length === 0) {
    info?.("✅ No security findings detected.");
    return;
  }

  for (const finding of result.findings) {
    const icon =
      finding.severity === "CRITICAL"
        ? "🔴"
        : finding.severity === "HIGH"
          ? "🟠"
          : finding.severity === "MEDIUM"
            ? "🟡"
            : "🔵";
    const location = finding.file
      ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
      : "";

    const logMethod =
      finding.severity === "CRITICAL" || finding.severity === "HIGH"
        ? error
        : finding.severity === "MEDIUM"
          ? warning
          : info;

    logMethod?.(`${icon} [${finding.severity}] ${finding.message}${location}`);
    if (finding.remediation) {
      info?.(`   → ${finding.remediation}`);
    }
  }

  info?.("");
  info?.(
    `Summary: ${result.summary.critical} critical, ${result.summary.high} high, ${result.summary.medium} medium, ${result.summary.low} low`,
  );
}
