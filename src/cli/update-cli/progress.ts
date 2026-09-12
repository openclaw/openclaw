// Update command presentation helpers: spinner lifecycle, failure hints, and result summaries.
import { spinner } from "@clack/prompts";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunPhase, UpdateRunRecord } from "../../infra/update-run-record.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type {
  UpdateRunResult,
  UpdateStepAdvisory,
  UpdateStepProgress,
  UpdateStepResult,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

// One command owns each observer. The final report flushes it before printing so
// a fast final transition cannot appear after the report or leave a spinner active.
const activeUpdateProgress = new Map<string, (record: UpdateRunRecord | undefined) => void>();
const UPDATE_PROGRESS_POLL_MS = 250;

function isAdvisoryStep(step: { advisory?: UpdateStepAdvisory }): boolean {
  return step.advisory !== undefined;
}

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

/** Runner-facing progress callbacks plus terminal spinner cleanup. */
type ProgressController = {
  progress: UpdateDisplayProgress;
  stop: () => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
};

/** Create a progress adapter for the updater runner without coupling runner code to terminal UI. */
export function createUpdateProgress(
  enabled: boolean,
  run?: UpdateCommandOptions["run"],
): ProgressController {
  if (!enabled) {
    return { progress: {}, stop: () => {}, suspend: () => {}, resume: () => {}, dispose: () => {} };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentPhase: UpdateRunPhase | undefined;
  let observation: "active" | "suspended" | "disposed" = "active";
  const seenPhases = new Set<UpdateRunPhase>();
  const seenFailures = new Map<string, string>();
  const stop = () => {
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
    observation === "active" && run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
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
  const flush = (record: UpdateRunRecord | undefined) => {
    renderRecord(record);
    stop();
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
    // Initial observation can throw; publish only once the caller can own cleanup.
    poll();
    activeUpdateProgress.set(run.runId, flush);
  }
  const progress: UpdateDisplayProgress = {
    onStepStart: (step, record) => {
      flush(record ?? read());
      const label = currentPhase ? `${currentPhase} — ${step.name}` : step.name;
      if (process.stdout.isTTY) {
        currentSpinner = spinner({ indicator: "timer" });
        currentSpinner.start(theme.accent(label));
      } else {
        defaultRuntime.log(`${label}...`);
      }
    },
    onStepComplete: (step, record) => {
      flush(record ?? read());
      const previousFailure = seenFailures.get(step.name);
      printStep(step, Boolean(step.failureSummary && previousFailure === step.failureSummary));
      if (step.failureSummary && step.exitCode !== 0) {
        seenFailures.set(step.name, step.failureSummary);
      } else {
        seenFailures.delete(step.name);
      }
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
    dispose: () => {
      try {
        flush(read());
      } finally {
        observation = "disposed";
        clearTimer();
        if (run && activeUpdateProgress.get(run.runId) === flush) {
          activeUpdateProgress.delete(run.runId);
        }
      }
    },
  };
}

type DisplayStep = Pick<
  UpdateStepResult,
  | "name"
  | "durationMs"
  | "exitCode"
  | "advisory"
  | "stdoutTail"
  | "stderrTail"
  | "failureSummary"
  | "termination"
  | "signal"
>;

function printStep(step: DisplayStep, repeatedFailure = false): void {
  const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
  const termination =
    step.termination === "timeout" || step.termination === "no-output-timeout"
      ? " — timed out"
      : step.signal
        ? ` — interrupted (${step.signal})`
        : "";
  defaultRuntime.log(
    `  ${formatStepStatus(step)} ${step.name}${termination}${repeatedFailure ? " — same failure" : ""} ${duration}`,
  );
  if (!isAdvisoryStep(step) && step.exitCode === 0) {
    return;
  }
  if (repeatedFailure) {
    return;
  }
  if (step.failureSummary && !step.advisory) {
    defaultRuntime.log(`    ${theme.error(step.failureSummary)}`);
    return;
  }
  // Build tools often report failures on stdout. Keep the final diagnostic from
  // each stream, so npm's stderr footer cannot hide the actual build error.
  const color = isAdvisoryStep(step) ? theme.warn : theme.error;
  if (step.advisory) {
    defaultRuntime.log(`    ${color(step.advisory.message)}`);
  }
  for (const output of [step.stdoutTail, step.stderrTail]) {
    for (const line of (output ?? "").trimEnd().split("\n").slice(-10)) {
      if (line.trim()) {
        defaultRuntime.log(`    ${color(line)}`);
      }
    }
  }
}

function formatStepStatus(step: {
  exitCode: number | null;
  advisory?: UpdateStepAdvisory;
}): string {
  if (isAdvisoryStep(step)) {
    return theme.warn("!");
  }
  if (step.exitCode === 0) {
    return theme.success("\u2713");
  }
  if (step.exitCode === null) {
    return theme.warn("?");
  }
  return theme.error("\u2717");
}

/** Render a completed updater run as JSON or terminal output. */
export function printResult(
  result: UpdateRunResult,
  opts: UpdateCommandOptions,
  reportHints: { doctorHint?: string | null; nextAction?: string } = {},
): void {
  const run = result.runId ? getUpdateRun(result.runId, { env: opts.run?.env }) : undefined;
  if (opts.json) {
    defaultRuntime.writeJson({ ...result, ...(run ? { run } : {}) });
    return;
  }
  if (result.runId) {
    activeUpdateProgress.get(result.runId)?.(run);
  }
  const report = renderUpdateRunReport(run ?? updateRunReportInputFromResult(result), reportHints);
  defaultRuntime.log("");
  defaultRuntime.log(theme.heading(report.headline));
  for (const line of report.lines) {
    defaultRuntime.log(line);
  }
}
