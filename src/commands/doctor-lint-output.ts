import { formatCliJsonFailure } from "../cli/failure-output.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatUpdateDoctorLintFinding } from "../infra/update-doctor-lint.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

const DOCTOR_LINT_JSON_SCHEMA_VERSION = 1;

function formatJsonResult(result: {
  ok: boolean;
  checksRun: number;
  checksSkipped: number;
  findings: readonly HealthFinding[];
  warnings?: readonly HealthFinding[];
}) {
  return {
    schemaVersion: DOCTOR_LINT_JSON_SCHEMA_VERSION,
    ok: result.ok,
    checksRun: result.checksRun,
    checksSkipped: result.checksSkipped,
    findings: result.findings.map(toJsonFinding),
    // Shipped updater gates require findings to be empty on success.
    ...(result.warnings?.length ? { warnings: result.warnings.map(toJsonFinding) } : {}),
  };
}

export function writeJsonResult(result: Parameters<typeof formatJsonResult>[0]): void {
  process.stdout.write(JSON.stringify(formatJsonResult(result)) + "\n");
  if (isUpdateDoctorLintPass(process.env)) {
    // Shipped parents keep line tails; print blockers last, outside the single JSON line.
    for (const finding of [...(result.warnings ?? []), ...result.findings].toSorted(
      (a, b) => Number(a.severity === "error") - Number(b.severity === "error"),
    )) {
      process.stderr.write(`${formatUpdateDoctorLintFinding(finding)}\n`);
    }
  }
}

/** Shipped updaters parse failed lint output too; retain its readiness envelope. */
export function formatDoctorLintFailure(error: unknown) {
  const failure = formatCliJsonFailure(error);
  return {
    ...failure,
    ...formatJsonResult({
      ok: false,
      checksRun: 0,
      checksSkipped: 0,
      findings: [
        {
          checkId: "core/doctor/lint-inspection",
          severity: "error",
          source: "doctor",
          message: failure.error.message,
          fixHint: "Resolve this inspection error, then rerun `openclaw doctor --lint`.",
        },
      ],
    }),
  };
}

function toJsonFinding(f: HealthFinding): Record<string, unknown> {
  return {
    checkId: f.checkId,
    severity: f.severity,
    message: f.message,
    ...(f.source !== undefined ? { source: f.source } : {}),
    ...(f.errorCode !== undefined ? { errorCode: f.errorCode } : {}),
    ...(f.path !== undefined ? { path: f.path } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.column !== undefined ? { column: f.column } : {}),
    ...(f.ocPath !== undefined ? { ocPath: f.ocPath } : {}),
    ...(f.target !== undefined ? { target: f.target } : {}),
    ...(f.requirement !== undefined ? { requirement: f.requirement } : {}),
    ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
  };
}
