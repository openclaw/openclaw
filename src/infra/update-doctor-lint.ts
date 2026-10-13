import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import {
  UpdateDoctorLintFindingSchema,
  type UpdateDoctorLintFinding,
} from "./update-doctor-lint-schema.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import type { UpdateStepResult } from "./update-step-result.js";

export const UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX = "[warning] Doctor disposal";

const UpdateDoctorLintReportSchema = z.object({
  ok: z.boolean(),
  checksRun: z.number().nonnegative().refine(Number.isInteger),
  findings: z.array(UpdateDoctorLintFindingSchema),
  warnings: z
    .array(UpdateDoctorLintFindingSchema.extend({ severity: z.literal("warning") }))
    .optional(),
});

function normalizeFinding(
  finding: UpdateDoctorLintFinding,
  env: NodeJS.ProcessEnv,
): UpdateDoctorLintFinding {
  const safe = UpdateDoctorLintFindingSchema.parse(finding);
  const context = { env, stateDir: resolveStateDir(env) };
  for (const [key, limit] of [
    ["checkId", 128],
    ["message", 500],
    ["source", 128],
    ["errorCode", 80],
    ["fixHint", 500],
    ["severity", 16],
    ["path", 128],
    ["requirement", 200],
  ] as const) {
    const value = safe[key];
    if (value !== undefined) {
      safe[key] = redactSupportDiagnosticLine(
        value.replace(/[\r\n\u2028\u2029]+/gu, "; "),
        context,
        limit,
      );
    }
  }
  return safe;
}

export function normalizeUpdateDoctorLintFindings(
  findings: readonly UpdateDoctorLintFinding[],
  env: NodeJS.ProcessEnv = process.env,
): UpdateDoctorLintFinding[] {
  return findings.map((finding) => normalizeFinding(finding, env));
}

export function formatUpdateDoctorLintFinding(
  finding: UpdateDoctorLintFinding,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const safe = normalizeFinding(finding, env);
  return truncateUtf16Safe(
    `Doctor lint ${safe.severity ?? "error"} [${safe.checkId}]: ${[safe.requirement, safe.message, safe.fixHint].filter(Boolean).join(": ")}`,
    500,
  );
}

export function parseUpdateDoctorLintReport(stdout: string, env: NodeJS.ProcessEnv = process.env) {
  const validated = UpdateDoctorLintReportSchema.safeParse(JSON.parse(stdout));
  if (!validated.success) {
    throw new Error("Updated Doctor returned an invalid readiness result.");
  }
  const result = validated.data;
  if (result.ok && result.findings.length) {
    throw new Error("Updated Doctor returned findings with a successful readiness result.");
  }
  // Published 2026.9.5 candidates predate update-specific policy classification.
  const policy = result.findings.filter(
    (finding) => finding.checkId === "core/doctor/security" && finding.severity === "error",
  );
  const findings = result.findings.filter((finding) => !policy.includes(finding));
  const warnings = [
    ...policy.map((finding) => ({ ...finding, severity: "warning" })),
    ...(result.warnings ?? []),
  ];
  return {
    ok: result.ok,
    checksRun: result.checksRun,
    findings,
    warnings,
    doctorLintFindings: normalizeUpdateDoctorLintFindings([...findings, ...warnings], env),
    advisoryOnly:
      !result.ok &&
      policy.length > 0 &&
      findings.every((finding) => finding.severity === "warning" || finding.severity === "info"),
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

export function applyUpdateDoctorLintReport(
  step: UpdateStepResult,
  stdout: string,
  code: number | null,
  env: NodeJS.ProcessEnv,
) {
  if (code === 0 && step.outputLimitExceeded) {
    throw new Error("Update health check output exceeded the inspection limit");
  }
  let report: ReturnType<typeof parseUpdateDoctorLintReport> | undefined;
  if (!step.outputLimitExceeded) {
    try {
      report = parseUpdateDoctorLintReport(stdout, env);
    } catch (error) {
      if (code === 0) {
        throw error;
      }
      // Failed children can exit before emitting JSON; the caller retains stderr.
    }
  }
  if (
    code === 1 &&
    step.termination === "exit" &&
    !step.signal &&
    !step.killed &&
    report?.advisoryOnly
  ) {
    step.advisory = {
      kind: "recoverable-maintenance",
      message: "Doctor security policy findings are advisory during updates.",
    };
  }
  step.doctorLintFindings = report?.doctorLintFindings ?? [];
  const warnings = step.doctorLintFindings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => formatUpdateDoctorLintFinding(finding, env));
  if (warnings.length) {
    step.warnings = warnings;
  }
  return report;
}
