// Frozen v2026.9.5 acceptance contract, commit ec9c1a13db8938e5a3eaa51fca2e981cde2395a9.
// Reader: src/infra/update-doctor-lint.ts, blob 11aa934996ef1bd6bf1afe571e897cfb6efd982f.
// isRecord: packages/normalization-core/src/record-coerce.ts,
// blob 96ea2e55442827dd2334b847de7f6907ebcbf1df. Keep validation independent of main.
// Only the exported parser name and derived failureFacts/env projection differ;
// failure-fact normalization is diagnostic and does not validate the input report.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type UpdateDoctorLintFinding = {
  checkId: string;
  message: string;
  source?: string;
  errorCode?: string;
  fixHint?: string;
  severity?: string;
  path?: string;
  requirement?: string;
};

function parseFinding(finding: unknown, warning = false): UpdateDoctorLintFinding {
  if (
    !isRecord(finding) ||
    typeof finding.checkId !== "string" ||
    typeof finding.message !== "string" ||
    (finding.source !== undefined && typeof finding.source !== "string") ||
    (finding.errorCode !== undefined && typeof finding.errorCode !== "string") ||
    (finding.fixHint !== undefined && typeof finding.fixHint !== "string") ||
    (finding.severity !== undefined && typeof finding.severity !== "string") ||
    (finding.path !== undefined && typeof finding.path !== "string") ||
    (finding.requirement !== undefined && typeof finding.requirement !== "string") ||
    (warning && finding.severity !== "warning")
  ) {
    throw new Error("Updated Doctor returned an invalid readiness finding.");
  }
  return {
    checkId: finding.checkId,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.errorCode !== undefined ? { errorCode: finding.errorCode } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
    ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
  };
}

export function parseReleasedDoctorLintReport(stdout: string): {
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
  const findings = result.findings.map((finding) => parseFinding(finding));
  return {
    ok: result.ok,
    checksRun: result.checksRun,
    findings,
    warnings: (result.warnings ?? []).map((finding) => parseFinding(finding, true)),
  };
}
