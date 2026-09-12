import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type UpdateDoctorLintFinding = {
  checkId: string;
  message: string;
  source?: string;
  fixHint?: string;
};

function parseFinding(finding: unknown, warning = false): UpdateDoctorLintFinding {
  if (
    !isRecord(finding) ||
    typeof finding.checkId !== "string" ||
    typeof finding.message !== "string" ||
    (finding.source !== undefined && typeof finding.source !== "string") ||
    (finding.fixHint !== undefined && typeof finding.fixHint !== "string") ||
    (warning && finding.severity !== "warning")
  ) {
    throw new Error("Updated Doctor returned an invalid readiness finding.");
  }
  return {
    checkId: finding.checkId,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}

export function parseUpdateDoctorLintReport(stdout: string): {
  ok: boolean;
  checksRun: number;
  findings: UpdateDoctorLintFinding[];
  warnings: UpdateDoctorLintFinding[];
} {
  const result: unknown = JSON.parse(stdout);
  if (
    !isRecord(result) ||
    typeof result.ok !== "boolean" ||
    typeof result.checksRun !== "number" ||
    !Number.isInteger(result.checksRun) ||
    result.checksRun < 0 ||
    !Array.isArray(result.findings) ||
    (result.warnings !== undefined && !Array.isArray(result.warnings))
  ) {
    throw new Error("Updated Doctor returned an invalid readiness result.");
  }
  return {
    ok: result.ok,
    checksRun: result.checksRun,
    findings: result.findings.map((finding) => parseFinding(finding)),
    warnings: (result.warnings ?? []).map((finding) => parseFinding(finding, true)),
  };
}
