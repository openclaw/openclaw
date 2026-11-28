import { formatCliJsonFailure } from "../cli/failure-output.js";
import { createCliProgress } from "../cli/progress.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { exitCodeFromFindings } from "../flows/doctor-lint-flow.js";
import {
  healthFindingMeetsSeverity,
  type HealthFinding,
  type HealthFindingSeverity,
} from "../flows/health-checks.js";
import { formatUpdateDoctorLintFinding } from "../infra/update-doctor-lint.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";
import type { RecoveryDiskUsage } from "./recovery-disk-usage.js";

const DOCTOR_LINT_JSON_SCHEMA_VERSION = 1;

function formatJsonResult(result: {
  ok: boolean;
  checksRun: number;
  checksSkipped: number;
  findings: readonly HealthFinding[];
  warnings?: readonly HealthFinding[];
  databaseStores?: readonly Record<string, unknown>[];
  recoveryCopies?: RecoveryDiskUsage;
}) {
  return {
    schemaVersion: DOCTOR_LINT_JSON_SCHEMA_VERSION,
    ok: result.ok,
    checksRun: result.checksRun,
    checksSkipped: result.checksSkipped,
    findings: result.findings.map(toJsonFinding),
    ...(result.databaseStores ? { databaseStores: result.databaseStores } : {}),
    ...(result.recoveryCopies ? { recoveryCopies: result.recoveryCopies } : {}),
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
    status: "blocked",
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
    ...(f.details !== undefined ? { details: f.details } : {}),
  };
}

export type DoctorLintExecution = {
  checksRun: number;
  checksSkipped: number;
  cleanupWarnings?: readonly HealthFinding[];
  databaseStores?: readonly Record<string, unknown>[];
  recoveryCopies?: RecoveryDiskUsage;
  exitCode: number;
  findings: readonly HealthFinding[];
  warnings?: readonly HealthFinding[];
  writeOutput: () => void;
};

export type DoctorLintProgress = {
  phase: (label: string) => void;
  check: (index: number, total: number, checkId: string) => void;
  stop: () => void;
};

export const noDoctorLintProgress: DoctorLintProgress = { phase() {}, check() {}, stop() {} };

/**
 * One spinner line on an interactive stderr, like the other long CLI commands. An explicit
 * `--json` turns it off, as it does for them; update passes and rehearsals keep their parents'
 * parsed stderr unchanged. createCliProgress itself stays silent when stderr is not a terminal.
 */
export function createDoctorLintProgress(
  opts: DoctorLintCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): DoctorLintProgress {
  const progress = createCliProgress({
    label: "Doctor lint: starting",
    indeterminate: true,
    enabled: opts.json !== true && !isUpdateDoctorLintPass(env) && !resolveUpdateRehearsalRoot(env),
  });
  return {
    phase(label) {
      progress.setLabel(`Doctor lint: ${label}`);
    },
    check(index, total, checkId) {
      const percent = total > 0 ? Math.round((index / total) * 100) : 0;
      progress.setPercent(percent);
      progress.setLabel(`Doctor lint: check ${index + 1}/${total} (${percent}%) ${checkId}`);
    },
    stop() {
      progress.done();
    },
  };
}

export function detectDoctorLintOutputMode(opts: DoctorLintCliOptions): "human" | "json" {
  return opts.json === true || !process.stdout.isTTY ? "json" : "human";
}

/** Rehearsal lint deferred by the update budget: no checks ran, and the deferral is the report. */
export function createDeferredInspectionExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  warnings: HealthFinding[],
): DoctorLintExecution {
  return {
    checksRun: 0,
    checksSkipped: 0,
    exitCode: 0,
    findings: warnings,
    writeOutput() {
      if (detectDoctorLintOutputMode(opts) === "json") {
        writeJsonResult({ ok: true, checksRun: 0, checksSkipped: 0, findings: [], warnings });
      } else {
        for (const finding of warnings) {
          runtime.log(`[warning] ${finding.checkId} [${finding.errorCode}]: ${finding.message}`);
          runtime.log(finding.fixHint ?? "Run `openclaw doctor` after activation.");
        }
      }
    },
  };
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
    databaseStores: completed?.databaseStores,
    recoveryCopies: completed?.recoveryCopies,
    warnings: completed?.warnings,
    writeOutput() {
      if (detectDoctorLintOutputMode(opts) === "json") {
        writeJsonResult({
          ok: false,
          checksRun,
          checksSkipped,
          findings: visible,
          databaseStores: completed?.databaseStores,
          recoveryCopies: completed?.recoveryCopies,
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
