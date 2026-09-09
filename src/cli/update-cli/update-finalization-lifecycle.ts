import { writeSync } from "node:fs";
import { formatErrorMessage } from "../../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { UPDATE_RUN_HEARTBEAT_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { watchCliExitAfterOutput } from "../one-shot-exit.js";
import { hasCliProcessScope } from "../runtime-cleanup-scope.js";
import { getPendingCliDisposers } from "../runtime-cleanup.js";
import { UpdateFinalizationOutput } from "./update-finalization-output.js";
import { inspectUpdateFinalizationChildren } from "./update-finalization-processes.js";

// Repair Doctor has no automatic deadline, including its enclosing convergence
// phase. Other phases remain bounded; an explicit timeout applies to every phase.
const PHASE_BUDGET_MS = {
  preflight: 30_000,
  targetConfigValidation: 30_000,
  configSnapshot: 30_000,
  doctor: undefined,
  plugins: 600_000,
  targetConfigConvergence: undefined,
  completionCache: 30_000,
};
type Phase = keyof typeof PHASE_BUDGET_MS;
type DoctorPhase = "doctor" | "targetConfigConvergence";
type Outcome = "completed" | "failed" | "warning" | "skipped" | "deferred";

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
  private timer?: NodeJS.Timeout;
  private deferredExitWatch?: () => void;
  completed = false;
  private active?: { phase: Phase; step: string; startedAtMs: number };

  constructor(
    private readonly json: boolean,
    private readonly timeoutMs: number | undefined,
    private readonly stopChildren: () => void,
  ) {}

  attachLedger(): void {
    this.driver = readUpdateRunDriver();
    const inherited = process.env[UPDATE_RUN_ID_ENV]?.trim();
    this.ledgerOptions = { env: { ...process.env } };
    this.runId = createUpdateRun(
      { runId: inherited || undefined, trigger: "cli" },
      this.ledgerOptions,
    ).runId;
    this.ownsRun = !inherited;
    adoptUpdateRun(this.runId, this.ledgerOptions);
    if (this.active) {
      recordUpdateRunStep(
        this.runId,
        { step: this.active.step, status: "in_progress", startedAtMs: this.active.startedAtMs },
        this.ledgerOptions,
      );
    }
  }

  private record(
    active: { phase: Phase; step: string },
    status: "in_progress" | "completed" | "failed",
    at: number,
    detail?: string,
  ): void {
    const step = {
      step: active.step,
      status,
      ...(detail ? { detail } : {}),
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

  budget(phase: DoctorPhase): number | undefined;
  budget(phase: Exclude<Phase, DoctorPhase>): number;
  budget(phase: Phase): number | undefined;
  budget(phase: Phase): number | undefined {
    const budgetMs = this.timeoutMs ?? PHASE_BUDGET_MS[phase];
    return budgetMs === undefined ? undefined : Math.min(budgetMs, 2_147_483_647);
  }

  async run<T>(phase: Phase, run: () => Promise<T>, outcome?: (result: T) => Outcome): Promise<T> {
    const startedAt = performance.now();
    const startedAtMs = Date.now();
    const budgetMs = this.budget(phase);
    const active = { phase, step: `finalize:${phase}`, startedAtMs };
    this.active = active;
    this.record(active, "in_progress", startedAtMs);
    const output = new UpdateFinalizationOutput();
    const heartbeat = setInterval(() => {
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
    heartbeat.unref();
    const end = (result: Outcome, detail?: string) => {
      this.phaseTimings.push({
        phase,
        startedOffsetMs: Math.max(0, Math.round(startedAt - this.startedAt)),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: result,
      });
      this.record(active, result === "failed" ? "failed" : "completed", Date.now(), detail);
    };
    // Borrowed invocations keep awaiting the phase without taking over their host's lifetime.
    if (budgetMs !== undefined && hasCliProcessScope()) {
      this.timer = setTimeout(() => {
        // Do not race and unwind a still-mutating phase. Kill owned subprocesses and
        // exit without yielding, so late awaits cannot write into an OCM rollback.
        try {
          let diagnostics: ReturnType<typeof inspectUpdateFinalizationChildren>;
          try {
            // The parent still owns the update; capture names before killing them.
            // No result or rollback handoff can occur during this bounded synchronous read.
            diagnostics = inspectUpdateFinalizationChildren();
          } finally {
            this.stopChildren();
          }
          const doctorOutput = output.snapshot();
          // Persist received output with the failed phase before the existing finish.
          // Child inventory remains separate and is never process-kill authority.
          end("failed", doctorOutput ? formatDoctorOutputDetail(doctorOutput) : undefined);
          const error = `Update finalization timed out in ${phase} after ${budgetMs}ms`;
          this.finishLedger(1, error);
          writeSync(2, `${error}\n`);
          if (doctorOutput) {
            writeSync(2, `[update finalize] Doctor output: ${JSON.stringify(doctorOutput)}\n`);
          }
          writeSync(
            2,
            `[update finalize] Stalled phase children: ${JSON.stringify(diagnostics)}\n`,
          );
          this.recordDiagnostic(JSON.stringify(diagnostics));
          if (this.json) {
            writeSync(
              1,
              `${JSON.stringify({ status: "failed", mode: "finalize", root: this.root, restart: false, stuckPhase: phase, elapsedMs: Math.round(performance.now() - this.startedAt), error, phaseTimings: this.phaseTimings, ...diagnostics, ...(doctorOutput ? { doctorOutput } : {}) })}\n`,
            );
          }
        } finally {
          defaultRuntime.exit(1);
        }
      }, budgetMs);
    }
    try {
      const result = await output.run(run);
      end(outcome?.(result) ?? "completed");
      return result;
    } catch (error) {
      end("failed");
      throw error;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(this.timer);
      this.active = undefined;
      output.close();
    }
  }

  private finishLedger(exitCode: number, reason?: string): void {
    if (this.runId && this.ownsRun) {
      try {
        finishUpdateRun(
          this.runId,
          { status: exitCode ? "failed" : "succeeded", reason },
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
    clearTimeout(this.timer);
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
    clearTimeout(this.timer);
    this.finishLedger(exitCode);
    if (!hasCliProcessScope()) {
      return;
    }
    // This timer never keeps a healthy command alive. Once output has a terminal
    // outcome, retained handles or cleanup must not withhold EOF from supervisors.
    const watch = () =>
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
    // Human repair may still await a recovery choice or agent after reporting failure.
    if (this.json) {
      watch();
    } else {
      this.deferredExitWatch = watch;
    }
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
