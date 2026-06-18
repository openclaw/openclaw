// Plain-English rendering for structured doctor findings.
import { formatCliCommand } from "../cli/command-format.js";
import {
  HEALTH_FINDING_SEVERITY_RANK,
  type HealthFinding,
  type HealthFindingSeverity,
} from "../flows/health-checks.js";

export interface DoctorExplainRenderOptions {
  readonly checksRun: number;
  readonly findings: readonly HealthFinding[];
}

interface CheckExplanation {
  readonly label: string;
  readonly what: string;
  readonly why: string;
}

const CHECK_EXPLANATIONS: Record<string, CheckExplanation> = {
  "core/doctor/command-owner": {
    label: "Command owner",
    what: "No command owner is configured.",
    why: "Owner-only commands and dangerous action approvals may not reach the right person.",
  },
  "core/doctor/codex-session-routes": {
    label: "Codex session routes",
    what: "Some Codex model or session routes point at stale setup.",
    why: "Agent runs can use the wrong runtime, auth route, or model until these routes are repaired.",
  },
  "core/doctor/final-config-validation": {
    label: "Config file",
    what: "OpenClaw found a config value it cannot read safely.",
    why: "OpenClaw commands may ignore that setting or fail before the Gateway starts.",
  },
  "core/doctor/gateway-auth": {
    label: "Gateway auth",
    what: "Gateway authentication is not ready for the current command path.",
    why: "The CLI, dashboard, or channels may fail to connect to the Gateway.",
  },
  "core/doctor/gateway-config": {
    label: "Gateway config",
    what: "Gateway setup is incomplete.",
    why: "OpenClaw cannot reliably start or find the Gateway until this is configured.",
  },
  "core/doctor/lint-selection": {
    label: "Selected check",
    what: "The selected health check id is not registered.",
    why: "OpenClaw cannot run or repair a check it does not know about.",
  },
  "core/doctor/skills-readiness": {
    label: "Skills readiness",
    what: "One or more enabled skills are missing a local requirement.",
    why: "Agents may try to use a skill that cannot run on this machine.",
  },
};

export function formatDoctorExplainOutput(opts: DoctorExplainRenderOptions): string {
  const lines = [
    `doctor --explain: ran ${opts.checksRun} check(s), ${opts.findings.length} finding(s)`,
  ];
  if (opts.findings.length === 0) {
    lines.push("  no findings");
    return `${lines.join("\n")}\n`;
  }

  for (const group of groupFindings(opts.findings)) {
    const explanation = CHECK_EXPLANATIONS[group.checkId] ?? {
      label: labelFromCheckId(group.checkId),
      what: group.findings[0]?.message ?? "OpenClaw found a setup issue.",
      why: "This can affect startup, connectivity, or the feature named in the finding.",
    };
    lines.push("");
    lines.push(`${explanation.label} [${group.severity}]`);
    lines.push(`  Check: ${group.checkId}`);
    lines.push(`  What happened: ${explanation.what}`);
    lines.push(`  Why it matters: ${explanation.why}`);
    lines.push(`  Try this: ${formatFixHint(group.findings)}`);
    lines.push(`  Automatic repair: ${formatAutomaticRepair()}`);
    lines.push("  Details:");
    for (const finding of group.findings) {
      lines.push(`  - ${formatFindingDetail(finding)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function groupFindings(findings: readonly HealthFinding[]): readonly {
  checkId: string;
  severity: HealthFindingSeverity;
  findings: readonly HealthFinding[];
}[] {
  const groups = new Map<string, HealthFinding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.checkId);
    if (group === undefined) {
      groups.set(finding.checkId, [finding]);
    } else {
      group.push(finding);
    }
  }
  return [...groups.entries()].map(([checkId, group]) => ({
    checkId,
    severity: highestSeverity(group),
    findings: group,
  }));
}

function highestSeverity(findings: readonly HealthFinding[]): HealthFindingSeverity {
  return findings.reduce<HealthFindingSeverity>(
    (highest, finding) =>
      HEALTH_FINDING_SEVERITY_RANK[finding.severity] > HEALTH_FINDING_SEVERITY_RANK[highest]
        ? finding.severity
        : highest,
    "info",
  );
}

function formatFixHint(findings: readonly HealthFinding[]): string {
  const hint = findings.find((finding) => finding.fixHint !== undefined)?.fixHint;
  return hint ?? "Review the details below, update the affected setup, then rerun doctor.";
}

function formatAutomaticRepair(): string {
  return `This report is read-only. Run ${formatCliCommand(
    "openclaw doctor --fix",
  )} to apply supported repairs.`;
}

function formatFindingDetail(finding: HealthFinding): string {
  const location = finding.path ?? finding.ocPath ?? finding.target;
  if (location === undefined) {
    return finding.message;
  }
  return `${location}: ${finding.message}`;
}

function labelFromCheckId(checkId: string): string {
  const leaf = checkId.split("/").at(-1) ?? checkId;
  return leaf
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
