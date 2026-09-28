import { writeSync } from "node:fs";
import os from "node:os";
import { resolveStateDir } from "../../config/paths.js";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "../../infra/sqlite-readonly-worker.js";
import { readUpdateStateDatabaseSizes } from "../../infra/update-candidate-state.sizes.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  UpdateDoctorError,
} from "../../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunPhase,
  recordUpdateRunRepairContinuation,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import {
  UPDATE_RUN_HEARTBEAT_MS,
  UPDATE_RUNNER_TIMEOUT_MS,
} from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { watchCliExitAfterOutput } from "../one-shot-exit.js";
import { hasCliProcessScope } from "../runtime-cleanup-scope.js";
import { getPendingCliDisposers } from "../runtime-cleanup.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
} from "./update-command-result.js";
import { UpdateFinalizationOutput } from "./update-finalization-output.js";
import { inspectUpdateFinalizationChildren } from "./update-finalization-processes.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

type Phase =
  | "preflight"
  | "targetConfigValidation"
  | "configSnapshot"
  | "doctor"
  | "plugins"
  | "targetConfigConvergence"
  | "completionCache";
type DoctorPhase = "doctor" | "targetConfigConvergence";
type Outcome = "completed" | "failed" | "warning" | "skipped" | "deferred";

export type UpdateFinalizationPhase = {
  signal: AbortSignal;
  assertCurrent: () => void;
};

export class UpdateFinalizationLifecycle {
  readonly startedAt = performance.now();
  readonly phaseTimings: {
    phase: Phase;
    startedOffsetMs: number;
    durationMs: number;
    outcome: Outcome;
  }[] = [];
  root?: string;
  private runId?: string;
  private driver?: UpdateRunDriver;
  private ledgerOptions?: { env: NodeJS.ProcessEnv };
  private ownsRun = false;
  private warnedHeartbeat = false;
  private deferredExitWatch?: () => void;
  completed = false;
  private active?: { phase: Phase; step: string; startedAtMs: number };
  private stateBudgetMs: number | undefined;
  private reportTimeout?: () => void;
  private failureObservation?: UpdateRunResult;

  constructor(
    private readonly json: boolean,
    private readonly timeoutMs: number | undefined,
    private readonly stopChildren: () => void,
  ) {}

  get ownsUpdateRun(): boolean {
    return this.ownsRun;
  }

  attachLedger(repair = false): string {
    this.driver = readUpdateRunDriver();
    const inherited = process.env[UPDATE_RUN_ID_ENV]?.trim();
    this.ledgerOptions = { env: { ...process.env } };
    const admissionOptions = { ...this.ledgerOptions, busyTimeoutMs: this.budget("preflight") };
    this.runId = createUpdateRun(
      { runId: inherited || undefined, trigger: "cli" },
      admissionOptions,
    ).runId;
    this.ownsRun = !inherited;
    adoptUpdateRun(this.runId, admissionOptions);
    if (repair && this.ownsRun) {
      recordUpdateRunRepairContinuation(this.runId, this.runId, admissionOptions);
    }
    if (this.active) {
      recordUpdateRunStep(
        this.runId,
        { step: this.active.step, status: "in_progress", startedAtMs: this.active.startedAtMs },
        admissionOptions,
      );
    }
    return this.runId;
  }

  recordInstallKind(installKind: "git" | "package" | "unknown", version?: string | null): void {
    if (this.runId && this.ownsRun && installKind !== "unknown") {
      recordUpdateRunPhase(
        this.runId,
        "requested",
        {
          target: { kind: installKind, ...(version ? { version } : {}) },
          ...(version ? { after: { version } } : {}),
          ...(installKind === "package" && this.ledgerOptions?.env[POST_CORE_UPDATE_ENV] !== "1"
            ? {
                step: {
                  step: "finalize:package-rollback-not-needed",
                  status: "skipped" as const,
                  endedAtMs: Date.now(),
                  detail: "No package mutation during standalone finalization.",
                },
              }
            : {}),
        },
        this.ledgerOptions,
      );
    }
  }

  private record(
    active: { phase: Phase; step: string },
    status: "in_progress" | "completed" | "failed" | "skipped",
    at: number,
    detail?: string,
    failureFacts?: UpdateFailureFact[],
    exitCode?: number | null,
  ): void {
    const step = {
      step: active.step,
      status,
      ...(detail ? { detail } : {}),
      ...(failureFacts?.length ? { failureFacts } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(status === "failed"
        ? {
            reason:
              failureFacts?.find((fact) => fact.code.trim() && fact.code !== "finalization-failed")
                ?.code ?? active.step,
          }
        : {}),
      ...(status === "in_progress" ? { startedAtMs: at } : { endedAtMs: at }),
    };
    defaultRuntime.error(`[update finalize] ${JSON.stringify(step)}`);
    if (this.runId) {
      try {
        recordUpdateRunStep(this.runId, step, this.ledgerOptions);
      } catch {
        defaultRuntime.error("[update finalize] Could not persist phase diagnostic.");
      }
    }
  }

  recordWarnings(warnings: readonly string[], phase: "doctor" | "plugins" = "doctor"): void {
    warnings.forEach((detail, index) => {
      this.record(
        { phase, step: `warning:finalize:${phase}:${index}` },
        "completed",
        Date.now(),
        detail,
      );
    });
  }

  budget(phase: DoctorPhase): number | undefined;
  budget(phase: Exclude<Phase, DoctorPhase>): number;
  budget(phase: Phase): number | undefined;
  budget(phase: Phase): number | undefined {
    const budgetMs =
      this.timeoutMs ??
      (phase === "doctor" || phase === "targetConfigConvergence"
        ? undefined
        : phase === "plugins"
          ? UPDATE_RUNNER_TIMEOUT_MS
          : (this.stateBudgetMs ??
            resolveAggregateSqliteInspectionTimeoutMs("update finalization", [])));
    return budgetMs === undefined ? undefined : Math.min(budgetMs, 2_147_483_647);
  }

  async run<T>(
    phase: Phase,
    run: (phase: UpdateFinalizationPhase) => Promise<T>,
    outcome?: (result: T) => Outcome | { outcome: Outcome; failureFacts?: UpdateFailureFact[] },
    custody?: { enter?: () => Promise<void>; restore?: (result: T) => Promise<void> },
  ): Promise<T> {
    // Keep unresponsive source metadata inside the existing bounded worker.
    this.stateBudgetMs ??=
      this.timeoutMs ??
      resolveAggregateSqliteInspectionTimeoutMs(
        "update finalization",
        await readUpdateStateDatabaseSizes([resolveOpenClawStateSqlitePath(process.env)], {
          nodeRunner: process.execPath,
          sourceEnv: { ...process.env },
          stagingRoot: os.tmpdir(),
        }),
      );
    const startedAt = performance.now();
    const startedAtMs = Date.now();
    // Serial plugin operations keep their own deadlines; their total is not one step.
    const budgetMs =
      phase === "plugins" && this.timeoutMs === undefined ? undefined : this.budget(phase);
    const active = { phase, step: `finalize:${phase}`, startedAtMs };
    this.active = active;
    this.record(active, "in_progress", startedAtMs);
    const output = new UpdateFinalizationOutput();
    // Doctor holds the state-lifecycle coordinator while repairing shared state.
    // Keep its parent out of that database; recorded driver liveness still
    // prevents abandonment while phase-start and phase-end records report progress.
    const heartbeat =
      phase === "doctor" || phase === "targetConfigConvergence"
        ? undefined
        : setInterval(() => {
            try {
              if (this.runId) {
                heartbeatUpdateRun(this.runId, this.driver, this.ledgerOptions);
              }
            } catch (error) {
              if (!this.warnedHeartbeat) {
                this.warnedHeartbeat = true;
                console.warn(
                  `[update finalize] Could not refresh the update heartbeat; continuing: ${formatErrorMessage(error).slice(0, 500)}`,
                );
              }
            }
          }, UPDATE_RUN_HEARTBEAT_MS);
    heartbeat?.unref();
    const end = (
      result: Outcome,
      detail?: string,
      failureFacts?: UpdateFailureFact[],
      exitCode?: number | null,
    ) => {
      this.phaseTimings.push({
        phase,
        startedOffsetMs: Math.max(0, Math.round(startedAt - this.startedAt)),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: result,
      });
      this.record(
        active,
        result === "failed" ? "failed" : result === "deferred" ? "skipped" : "completed",
        Date.now(),
        detail,
        failureFacts,
        exitCode,
      );
    };
    let stopPhaseChildren = () => {};
    let doctorOutput: ReturnType<UpdateFinalizationOutput["snapshot"]>;
    const deadline = createUpdateOperationDeadline<UpdateCommandFinalizedRecoveryFailure>(
      (failure) => {
        let diagnostics: ReturnType<typeof inspectUpdateFinalizationChildren> = {
          childProcesses: [],
          childProcessInspection: "unavailable",
          childProcessesTruncated: false,
        };
        try {
          diagnostics = inspectUpdateFinalizationChildren();
        } catch {
          /* Diagnostic failure cannot prevent cancellation. */
        }
        doctorOutput = output.snapshot();
        stopPhaseChildren();
        this.reportTimeout = () => {
          writeSync(2, `${failure.message}\n`);
          if (doctorOutput) {
            writeSync(2, `[update finalize] Doctor output: ${JSON.stringify(doctorOutput)}\n`);
          }
          writeSync(
            2,
            `[update finalize] Stalled phase children: ${JSON.stringify(diagnostics)}\n`,
          );
          this.recordDiagnostic(JSON.stringify(diagnostics));
          if (this.json) {
            defaultRuntime.writeJson({
              status: "failed",
              mode: "finalize",
              root: this.root,
              restart: false,
              stuckPhase: phase,
              elapsedMs: Math.round(performance.now() - this.startedAt),
              error: failure.message,
              phaseTimings: this.phaseTimings,
              ...diagnostics,
              ...(doctorOutput ? { doctorOutput } : {}),
            });
          }
        };
      },
    );
    const scope: UpdateFinalizationPhase = {
      signal: resolveCommandProcessSignal(deadline.signal) ?? deadline.signal,
      assertCurrent: () => {
        deadline.assertCurrent();
        scope.signal.throwIfAborted();
      },
    };
    try {
      // Service custody must be acquired before cancellation, and restored outside it.
      await withCommandProcessScope(async () => {
        await custody?.enter?.();
      });
      // Borrowed invocations do not take over their host's lifetime.
      if (budgetMs !== undefined && hasCliProcessScope()) {
        const failure = new UpdateCommandFinalizedRecoveryFailure({
          status: "error",
          mode: "unknown",
          root: this.root,
          reason: "finalization-timeout",
          steps: [],
          durationMs: Math.round(performance.now() - this.startedAt),
        });
        failure.message = `Update finalization timed out in ${phase} after ${budgetMs}ms`;
        deadline.start(failure, budgetMs);
      }
      const result = await deadline.run(() =>
        withCommandProcessScope(async (stop) => {
          stopPhaseChildren = stop;
          scope.assertCurrent();
          return await output.run(() => run(scope));
        }, scope.signal),
      );
      await withCommandProcessScope(async () => {
        await custody?.restore?.(result);
      });
      const completed = outcome?.(result) ?? "completed";
      end(
        typeof completed === "string" ? completed : completed.outcome,
        undefined,
        typeof completed === "string" ? undefined : completed.failureFacts,
      );
      return result;
    } catch (error) {
      const failure = deadline.failure;
      if (failure) {
        this.record(
          { phase, step: `warning:finalize:${phase}:deadline` },
          "completed",
          Date.now(),
          failure.message,
        );
      }
      const facts = failure
        ? [
            createUpdateFailureFact({
              check: phase,
              code: "finalization-timeout",
              message: failure.message,
            }),
          ]
        : error instanceof UpdateDoctorError
          ? error.failureFacts
          : [
              createUpdateFailureFact({
                check: phase,
                code: extractErrorCode(error) ?? "finalization-failed",
                message: formatErrorMessage(error),
              }),
            ];
      const deferred =
        !failure &&
        error instanceof DoctorMaintenanceRefusalError &&
        error.refusal.kind === "deferred";
      end(
        deferred ? "deferred" : "failed",
        doctorOutput
          ? formatDoctorOutputDetail(doctorOutput)
          : redactSupportDiagnosticLine(formatErrorMessage(error), {
              env: process.env,
              stateDir: resolveStateDir(process.env),
            }),
        deferred ? undefined : facts,
        !deferred && error instanceof UpdateDoctorError ? error.exitCode : undefined,
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.active = undefined;
      output.close();
    }
  }

  async observeFailure(error: unknown): Promise<UpdateRunResult | undefined> {
    if (!this.root || !this.runId || !this.ledgerOptions || hasCommandProcessCleanupError(error)) {
      return undefined;
    }
    const { env } = this.ledgerOptions;
    const { verifyUpdateFailureRecovery } = await import("./update-command-failure-recovery.js");
    const result: UpdateRunResult =
      error instanceof UpdateCommandFailure
        ? error.result
        : {
            status: "error",
            mode: "unknown",
            root: this.root,
            steps: [],
            durationMs: Math.round(performance.now() - this.startedAt),
          };
    try {
      this.failureObservation = await verifyUpdateFailureRecovery({
        result,
        root: this.root,
        opts: { json: this.json, run: { runId: this.runId, env } },
        env,
        timeoutMs: this.timeoutMs,
      });
      return this.failureObservation;
    } catch (recoveryError) {
      if (hasCommandProcessCleanupError(recoveryError) && recoveryError !== error) {
        throw new AggregateError([error, recoveryError], "Update failure recovery did not settle", {
          cause: recoveryError,
        });
      }
      throw recoveryError;
    }
  }

  private finishLedger(exitCode: number): void {
    if (this.runId && this.ownsRun) {
      try {
        finishUpdateRun(
          this.runId,
          { status: exitCode ? "failed" : "succeeded", diagnostics: this.failureObservation },
          this.ledgerOptions,
        );
      } catch {
        defaultRuntime.error("[update finalize] Could not persist final outcome.");
      }
    }
  }

  private recordDiagnostic(diagnostic: string): void {
    if (this.runId) {
      try {
        recordUpdateRunDiagnostic(this.runId, diagnostic, this.ledgerOptions);
      } catch {
        /* stderr still carries the diagnostic. */
      }
    }
  }

  fail(): void {
    this.finishLedger(1);
  }

  finishRecovery(): void {
    const watch = this.deferredExitWatch;
    this.deferredExitWatch = undefined;
    watch?.();
  }

  complete(exitCode: number): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.finishLedger(exitCode);
    this.reportTimeout?.();
    if (!hasCliProcessScope()) {
      return;
    }
    // Recovery may still await diagnostics after terminal output; arm the watchdog
    // from finishRecovery before unwinding resource cleanup.
    this.deferredExitWatch = () =>
      watchCliExitAfterOutput(exitCode, () => {
        const diagnostic = JSON.stringify({
          activeResources: [...new Set(process.getActiveResourcesInfo())].toSorted(),
          unsettledDisposers: getPendingCliDisposers(),
          ...inspectUpdateFinalizationChildren(),
        });
        writeSync(
          2,
          `[update finalize] Process still alive after terminal output: ${diagnostic}\n`,
        );
        this.recordDiagnostic(diagnostic);
        this.stopChildren();
      });
  }
}

function formatDoctorOutputDetail(
  output: NonNullable<ReturnType<UpdateFinalizationOutput["snapshot"]>>,
) {
  return [
    `Doctor ${output.phase} received output:`,
    ...(["stdout", "stderr"] as const).map((name) => {
      const stream = output[name];
      return `${name} ${stream.receivedBytes} bytes, last ${stream.lastOutputAgeMs ?? "none"}ms: ${"omitted" in stream ? `[omitted: ${stream.omitted}]` : stream.excerpt}`;
    }),
  ].join("\n");
}
