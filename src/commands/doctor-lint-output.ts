import { formatCliJsonFailure } from "../cli/failure-output.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { exitCodeFromFindings } from "../flows/doctor-lint-flow.js";
import {
  healthFindingMeetsSeverity,
  type HealthFinding,
  type HealthFindingSeverity,
} from "../flows/health-checks.js";
import { formatUpdateDoctorLintFinding } from "../infra/update-doctor-lint.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
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

export type DoctorLintExecution = {
  checksRun: number;
  checksSkipped: number;
  cleanupWarnings?: readonly HealthFinding[];
  exitCode: number;
  findings: readonly HealthFinding[];
  warnings?: readonly HealthFinding[];
  writeOutput: () => void;
};

export function detectDoctorLintOutputMode(opts: DoctorLintCliOptions): "human" | "json" {
  if (opts.json === true) {
    return "json";
  }
  return process.stdout.isTTY ? "human" : "json";
}

export function createStateSnapshotFailureFinding(error: Error): HealthFinding {
  return {
    checkId: "core/doctor/lint-state-inspection",
    severity: "error",
    source: "doctor",
    target: "plugin-state",
    requirement: "read-only-plugin-state-inspection",
    message:
      "Doctor lint could not inspect plugin state without mutating the live state database " +
      `(${scrubDoctorErrorMessage(error.cause ?? error)}).`,
    fixHint:
      "Keep the current Gateway running, resolve the state database inspection error, then rerun this check.",
  };
}

export async function createStateSnapshotFailureExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: HealthFindingSeverity,
  error: Error,
  completed?: DoctorLintExecution,
): Promise<DoctorLintExecution> {
  const { collectNodeRuntimeFindings } = await import("./node-runtime-diagnostics.js");
  const failures = [
    createStateSnapshotFailureFinding(error),
    ...(completed ? [] : await collectNodeRuntimeFindings()),
  ].filter((entry) => healthFindingMeetsSeverity(entry, sevMin));
  const visible = [...(completed?.findings ?? []), ...failures];
  const checksRun = completed?.checksRun ?? 0;
  const checksSkipped = completed?.checksSkipped ?? 0;
  return {
    checksRun,
    checksSkipped,
    exitCode: exitCodeFromFindings(visible, sevMin),
    findings: visible,
    cleanupWarnings: completed?.cleanupWarnings,
    warnings: completed?.warnings,
    writeOutput() {
      if (detectDoctorLintOutputMode(opts) === "json") {
        writeJsonResult({
          ok: false,
          checksRun,
          checksSkipped,
          findings: visible,
          warnings: [...(completed?.warnings ?? []), ...(completed?.cleanupWarnings ?? [])],
        });
        return;
      }
      completed?.writeOutput();
      for (const entry of failures) {
        runtime.error(`doctor --lint: ${entry.message}`);
        if (entry.fixHint) {
          runtime.error(`fix: ${entry.fixHint}`);
        }
      }
    },
  };
}
