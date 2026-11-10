import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { InstallPolicyFinding } from "../security/install-policy.js";

export function formatInstallPolicyFinding(finding: InstallPolicyFinding): string {
  const location = finding.file
    ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
    : "";
  const evidence = finding.evidence ? ` Evidence: ${finding.evidence}` : "";
  return terminalText`[${finding.severity.toUpperCase()}] ${finding.ruleId}: ${finding.message}${location}${evidence}`;
}

export function formatInstallPolicyNotice(params: {
  decision: "warn" | "block";
  findings?: InstallPolicyFinding[];
  guidance?: string[];
  reason: string;
  targetName: string;
  targetType: "skill" | "plugin";
}): string {
  const targetLabel = params.targetType === "skill" ? "Skill" : "Plugin";
  const lines = [
    params.decision === "warn" ? "Install requires approval" : "Install blocked by policy",
    "",
    terminalText`  ${targetLabel}: ${params.targetName}`,
    terminalText`  Reason: ${params.reason}`,
  ];
  if (params.findings?.length) {
    lines.push("  Findings:");
    for (const finding of params.findings) {
      lines.push(`    • ${formatInstallPolicyFinding(finding)}`);
    }
  }
  if (params.guidance?.length) {
    lines.push("", ...params.guidance);
  }
  return lines.join("\n");
}
