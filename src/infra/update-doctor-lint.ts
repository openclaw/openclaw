import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeUpdateFailureFacts, type UpdateFailureFact } from "./update-failure-facts.js";

export type UpdateDoctorLintFinding = {
  checkId: string;
  message: string;
  source?: string;
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
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
    ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
  };
}

export function parseUpdateDoctorLintReport(
  stdout: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  ok: boolean;
  checksRun: number;
  findings: UpdateDoctorLintFinding[];
  warnings: UpdateDoctorLintFinding[];
  failureFacts: UpdateFailureFact[];
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
    failureFacts: normalizeUpdateFailureFacts(
      findings
        .filter((finding) => finding.severity === "error" || finding.severity === undefined)
        .map((finding) => ({
          check: finding.checkId,
          code: "doctor-failed",
          message: [finding.requirement, finding.message].filter(Boolean).join(": "),
          affectedKey: finding.path,
        })),
      env,
    ),
  };
}
