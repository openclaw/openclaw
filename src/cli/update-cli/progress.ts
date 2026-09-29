import { spinner } from "@clack/prompts";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import { formatUpdateDoctorLintFinding } from "../../infra/update-doctor-lint.js";
import { formatUpdateFailureFact } from "../../infra/update-failure-facts-format.js";
import { writeUpdateRunReportArtifact } from "../../infra/update-failure-report-artifact.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  toPublicUpdateRun,
  updateStepDiagnostics,
  type UpdateRunPhase,
  type UpdateRunRecord,
} from "../../infra/update-run-record.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

// One command owns each observer. The final report flushes it before printing so
// a fast final transition cannot appear after the report or leave a spinner active.
const activeUpdateProgress = new Map<
  string,
  {
    finish: (record: UpdateRunRecord | undefined) => void;
    pause: () => void;
  }
>();
const UPDATE_PROGRESS_POLL_MS = 250;
const UPDATE_STEP_NOTICE_MS = 30_000;

// These CLI-only callbacks can render the row just committed by their ledger owner.
export type UpdateDisplayProgress = {
  onHeartbeat?: UpdateStepProgress["onHeartbeat"];
  onStepStart?: (
    step: Parameters<NonNullable<UpdateStepProgress["onStepStart"]>>[0],
    record?: UpdateRunRecord,
  ) => void;
  onStepComplete?: (
    step: Parameters<NonNullable<UpdateStepProgress["onStepComplete"]>>[0],
    record?: UpdateRunRecord,
  ) => void;
};

type ProgressController = {
  progress: UpdateDisplayProgress;
  stop: () => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
};

function readDisplayRecord(runId: string, env?: NodeJS.ProcessEnv, source = "report") {
  try {
    return getUpdateRun(runId, { env });
  } catch (error) {
    defaultRuntime.error(`Update ${source} history unavailable: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

export function createUpdateProgress(
  enabled: boolean,
  run?: UpdateCommandOptions["run"],
): ProgressController {
  if (!enabled) {
    return { progress: {}, stop: () => {}, suspend: () => {}, resume: () => {}, dispose: () => {} };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stepNotice: ReturnType<typeof setInterval> | undefined;
  let currentPhase: UpdateRunPhase | undefined;
  let observation: "active" | "suspended" | "disposed" = "active";
  const seenPhases = new Set<UpdateRunPhase>();
  const stop = () => {
    if (stepNotice) {
      clearInterval(stepNotice);
      stepNotice = undefined;
    }
    currentSpinner?.clear();
    currentSpinner = null;
  };
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  // Candidate migrations can advance the ledger beyond this process's reader.
  // Step callbacks and final cleanup must respect the same fence as the timer.
  const read = () =>
    observation === "active" && run ? readDisplayRecord(run.runId, run.env, "progress") : undefined;
  const renderRecord = (record: UpdateRunRecord | undefined) => {
    // Doctor's unbound spinner does not observe ledger phases, even after a write.
    if (observation !== "active" || !run || !record) {
      return;
    }
    currentPhase = record.phase;
    // A child process can cross several phases between reads. Replay the recorded
    // timeline rather than losing fast transitions or inferring unobserved phases.
    for (const phase of UPDATE_RUN_PHASES) {
      const recorded = record.steps.some(
        (step) => step.step === phase && step.status !== "pending",
      );
      if (!seenPhases.has(phase) && (recorded || phase === record.phase)) {
        seenPhases.add(phase);
        stop();
        defaultRuntime.log(`Phase: ${phase}`);
      }
    }
    if (record.status !== "running") {
      clearTimer();
    }
  };
  const finalize = (
    record: UpdateRunRecord | undefined,
    terminal = record?.status !== "running",
  ) => {
    try {
      renderRecord(record);
    } finally {
      if (terminal) {
        observation = "disposed";
        clearTimer();
        if (run && activeUpdateProgress.get(run.runId)?.finish === finalize) {
          activeUpdateProgress.delete(run.runId);
        }
      }
      stop();
    }
  };
  const poll = () => {
    timer = undefined;
    const record = read();
    renderRecord(record);
    if (record?.status === "running") {
      // The CLI owns this poll only for its active operation; fresh-process
      // finalization and gateway verification write the same ledger row.
      timer = setTimeout(poll, UPDATE_PROGRESS_POLL_MS);
      timer.unref?.();
    }
  };
  if (run) {
    // Register only after initial observation so failed setup leaves no callback.
    poll();
    activeUpdateProgress.set(run.runId, {
      finish: finalize,
      pause: () => {
        clearTimer();
        stop();
      },
    });
  }
  const progress: UpdateDisplayProgress = {
    onStepStart: (step, record) => {
      finalize(record ?? read(), false);
      const label = currentPhase ? `${currentPhase} — ${step.name}` : step.name;
      if (process.stdout.isTTY) {
        currentSpinner = spinner({ indicator: "timer" });
        currentSpinner.start(theme.accent(label));
      } else {
        defaultRuntime.log(`${label}...`);
        const startedAtMs = Date.now();
        stepNotice = setInterval(() => {
          defaultRuntime.log(
            `${label} — still running (${formatDurationPrecise(Date.now() - startedAtMs)})`,
          );
        }, UPDATE_STEP_NOTICE_MS);
        stepNotice.unref?.();
      }
    },
    onStepComplete: (step, record) => {
      finalize(record ?? read(), false);
      printStep(step);
    },
  };

  return {
    progress,
    stop,
    suspend: () => {
      if (observation === "active") {
        observation = "suspended";
        currentPhase = undefined;
        clearTimer();
        stop();
      }
    },
    resume: () => {
      if (observation === "suspended") {
        observation = "active";
        poll();
      }
    },
    dispose: () => finalize(read(), true),
  };
}

function printStep(step: Omit<UpdateStepResult, "cwd">): void {
  const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
  const termination =
    step.termination === "timeout" || step.termination === "no-output-timeout"
      ? " — timed out"
      : step.signal
        ? ` — interrupted (${step.signal})`
        : "";
  defaultRuntime.log(`  ${formatStepStatus(step)} ${step.name}${termination} ${duration}`);
  for (const finding of step.doctorLintFindings ?? []) {
    defaultRuntime.log(`    ${formatUpdateDoctorLintFinding(finding)}`);
  }
  if (step.advisory === undefined && !isFailedUpdateStep(step)) {
    return;
  }
  if (!step.advisory && step.failureFacts?.length) {
    for (const fact of step.failureFacts) {
      defaultRuntime.log(`    ${theme.error(formatUpdateFailureFact(fact))}`);
    }
  }
  // Build tools often report failures on stdout. Keep the final diagnostic from
  // each stream, so npm's stderr footer cannot hide the actual build error.
  const color = step.advisory !== undefined ? theme.warn : theme.error;
  if (step.advisory) {
    defaultRuntime.log(`    ${color(step.advisory.message)}`);
  }
  const tails = step.advisory
    ? [step.stdoutTail, step.stderrTail]
    : updateStepDiagnostics(step).tails;
  for (const output of tails) {
    for (const line of (output ?? "").trimEnd().split("\n").slice(-10)) {
      if (line.trim()) {
        defaultRuntime.log(`    ${color(line)}`);
      }
    }
  }
}

function formatStepStatus(step: Omit<UpdateStepResult, "cwd">): string {
  return step.advisory
    ? theme.warn("!")
    : !isFailedUpdateStep(step)
      ? theme.success("\u2713")
      : step.exitCode === null
        ? theme.warn("?")
        : theme.error("\u2717");
}

export async function printResult(
  result: UpdateRunResult,
  opts: UpdateCommandOptions,
  reportHints: {
    doctorHint?: string | null;
    nextAction?: string;
    record?: UpdateRunRecord;
    readHistory?: boolean;
  } = {},
): Promise<void> {
  const finalizeProgress = result.runId ? activeUpdateProgress.get(result.runId) : undefined;
  // Retire polling before waiting for report IO, including detached recovery.
  finalizeProgress?.pause();
  let run: UpdateRunRecord | undefined;
  let report: ReturnType<typeof renderUpdateRunReport> | undefined;
  const readRun =
    result.runId && !reportHints.record && reportHints.readHistory !== false
      ? () => readDisplayRecord(result.runId!, opts.run?.env)
      : undefined;
  // The artifact owner reads under its lock and reconciles after publication.
  // Captured and detached reports never reopen retained history.
  const renderReport = (current?: UpdateRunRecord) => {
    run = reportHints.record ?? current;
    finalizeProgress?.finish(run);
    report = renderUpdateRunReport(updateRunReportInputFromResult(result, run), {
      ...reportHints,
      mode: result.mode === "unknown" ? run?.target.kind : result.mode,
    });
    return report;
  };
  const reportPath = await writeUpdateRunReportArtifact({
    result,
    report: renderReport,
    readRun,
    env: opts.run?.env,
    detached: reportHints.readHistory === false,
  }).catch((error: unknown) => {
    defaultRuntime.error(`Update report could not be saved: ${formatErrorMessage(error)}`);
    return undefined;
  });
  report ??= renderReport(readRun?.());
  if (opts.json) {
    defaultRuntime.writeJson({
      ...result,
      ...(run ? { run: toPublicUpdateRun(run) } : {}),
      reportPath,
    });
    return;
  }
  defaultRuntime.log("");
  defaultRuntime.log(theme.heading(report.headline));
  if (reportPath) {
    defaultRuntime.log(`Report: ${reportPath}`);
  }
  for (const line of report.lines) {
    defaultRuntime.log(line);
  }
}
