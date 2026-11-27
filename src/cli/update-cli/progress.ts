import { spinner } from "@clack/prompts";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { clearActiveProgressLine } from "../../../packages/terminal-core/src/progress-line.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import { isStateDatabaseMaintenanceContention } from "../../infra/gateway-state-owner-record.js";
import { AUTOMATIC_RECOVERY_CLEANUP_STEP } from "../../infra/update-automatic-cleanup-result.js";
import { formatUpdateDoctorLintFinding } from "../../infra/update-doctor-lint.js";
import { formatUpdateFailureFact } from "../../infra/update-failure-facts-format.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunSummary } from "../../infra/update-run-notice.js";
import { formatUpdateOwedStep, listUpdateOwedSteps } from "../../infra/update-run-owed-step.js";
import { getUpdateRunForProgressAsync } from "../../infra/update-run-reader.js";
import {
  toPublicUpdateRun,
  updateStepDiagnostics,
  type UpdateRunPhase,
  type UpdateRunRecord,
} from "../../infra/update-run-record.js";
import { updateRunReportInputFromResult } from "../../infra/update-run-report.js";
import {
  isFailedUpdateStep,
  projectUpdateRunResultSteps,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { formatJsonConsoleLine, getConsoleSettings } from "../../logging/console.js";
import { isLogLevelEnabled } from "../../logging/levels.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";

// One command owns each observer. The final report flushes it before printing so
// a fast final transition cannot appear after the report or leave a spinner active.
const activeUpdateProgress = new Map<
  string,
  {
    finish: (record: UpdateRunRecord | undefined) => void;
    pause: () => void;
    suspendForDoctor: () => Promise<() => void>;
  }
>();

/**
 * Update Doctor children take exclusive SQLite custody of shared state. Any open
 * parent reader blocks that lock, so observation stops, and its in-flight read
 * settles, before the caller closes parent handles and spawns the child.
 */
export async function suspendUpdateProgressForDoctor(runId: string): Promise<() => void> {
  return (await activeUpdateProgress.get(runId)?.suspendForDoctor()) ?? (() => {});
}
const UPDATE_PROGRESS_POLL_MS = 250;
const UPDATE_STEP_NOTICE_MS = 30_000;

/** Child phase facts stay visible while schema changes defer ledger observation. */
export function createUpdateDoctorProgress(): ((line: string) => void) | undefined {
  const settings = getConsoleSettings();
  if (!isLogLevelEnabled("info", settings.level)) {
    return undefined;
  }
  return (message) => {
    const line =
      settings.style === "json" ? formatJsonConsoleLine({ level: "info", message }) : message;
    clearActiveProgressLine();
    process.stderr.write(`${line}\n`);
  };
}

// These CLI-only callbacks can render the row just committed by their ledger owner.
export type UpdateDisplayProgress = {
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
  let currentRecord: UpdateRunRecord | undefined;
  let pendingRead: AbortController | undefined;
  let pendingPoll: Promise<void> | undefined;
  let polling = true;
  let observation: "active" | "suspended" | "disposed" = "active";
  const seenPhases = new Set<UpdateRunPhase>();
  const stop = () => {
    clearInterval(stepNotice);
    stepNotice = undefined;
    currentSpinner?.clear();
    currentSpinner = null;
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const pausePolling = () => {
    polling = false;
    clearTimer();
    pendingRead?.abort();
  };
  const renderRecord = (record: UpdateRunRecord | undefined) => {
    // Doctor's unbound spinner does not observe ledger phases, even after a write.
    if (observation !== "active" || !run || !record) {
      return;
    }
    currentRecord = record;
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
        pausePolling();
        if (run && activeUpdateProgress.get(run.runId)?.finish === finalize) {
          activeUpdateProgress.delete(run.runId);
        }
      }
      stop();
    }
  };
  const poll = async () => {
    timer = undefined;
    if (!polling || pendingRead || observation !== "active" || !run) {
      return;
    }
    const controller = new AbortController();
    pendingRead = controller;
    try {
      const record = await getUpdateRunForProgressAsync(
        run.runId,
        { env: run.env },
        controller.signal,
      );
      // Activation can retire this reader while its native query is settling.
      if (!controller.signal.aborted) {
        if (!currentRecord || !record || record.updatedAtMs >= currentRecord.updatedAtMs) {
          renderRecord(record);
        }
        polling = record?.status === "running";
      }
    } catch (error) {
      // Doctor children hold their own custody; observation waits without borrowing it.
      if (!controller.signal.aborted && !isStateDatabaseMaintenanceContention(error)) {
        polling = false;
        defaultRuntime.error(`Update progress history unavailable: ${formatErrorMessage(error)}`);
      }
    } finally {
      pendingRead = undefined;
      if (polling && observation === "active") {
        timer = setTimeout(startPoll, UPDATE_PROGRESS_POLL_MS);
        timer.unref?.();
      }
    }
  };
  const startPoll = () => {
    pendingPoll = poll();
  };
  const suspend = () => {
    if (observation === "active") {
      observation = "suspended";
      currentRecord = undefined;
      pausePolling();
      stop();
    }
  };
  const resume = () => {
    if (observation === "suspended") {
      observation = "active";
      polling = true;
      startPoll();
    }
  };
  if (run) {
    startPoll();
    activeUpdateProgress.set(run.runId, {
      finish: finalize,
      pause: () => {
        pausePolling();
        stop();
      },
      suspendForDoctor: async () => {
        // Another owner's suspension stays theirs to resume.
        if (observation !== "active") {
          return () => {};
        }
        suspend();
        await pendingPoll;
        return resume;
      },
    });
  }
  const progress: UpdateDisplayProgress = {
    onStepStart: (step, record) => {
      finalize(record ?? currentRecord, false);
      const label = currentRecord ? `${currentRecord.phase} — ${step.name}` : step.name;
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
      finalize(record ?? currentRecord, false);
      printStep(step);
    },
  };

  return {
    progress,
    stop,
    suspend,
    resume,
    dispose: () => finalize(currentRecord, true),
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
  const statusIcon = step.advisory
    ? theme.warn("!")
    : !isFailedUpdateStep(step)
      ? theme.success("\u2713")
      : step.exitCode === null
        ? theme.warn("?")
        : theme.error("\u2717");
  defaultRuntime.log(`  ${statusIcon} ${step.name}${termination} ${duration}`);
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
    for (const line of (output ?? "")
      .trimEnd()
      .split("\n")
      .slice(step.termination === "signal" ? -80 : -10)) {
      if (line.trim()) {
        defaultRuntime.log(`    ${color(line)}`);
      }
    }
  }
}

/** Capture the completion history while the caller still owns terminal effects. */
export async function prepareResult(
  result: UpdateRunResult,
  opts: UpdateCommandOptions,
  reportHints: {
    nextAction?: string;
    record?: UpdateRunRecord;
    readHistory?: boolean;
  } = {},
  assertCurrent?: () => void,
): Promise<(additionalSteps?: readonly UpdateStepResult[]) => void> {
  assertCurrent?.();
  const finalizeProgress = result.runId ? activeUpdateProgress.get(result.runId) : undefined;
  finalizeProgress?.pause();
  const readRun =
    result.runId && !reportHints.record && reportHints.readHistory !== false
      ? () => {
          assertCurrent?.();
          try {
            return getUpdateRun(result.runId!, { env: opts.run?.env });
          } catch (error) {
            defaultRuntime.error(`Update report history unavailable: ${formatErrorMessage(error)}`);
            return undefined;
          }
        }
      : undefined;
  const run = reportHints.record ?? readRun?.();
  return (additionalSteps = []) => {
    // Supplemental diagnostics enrich output without reopening history.
    const reportedResult = additionalSteps.length
      ? { ...result, steps: [...result.steps, ...additionalSteps] }
      : result;
    const reportedRun = run ? projectUpdateRunResultSteps(run, additionalSteps) : undefined;
    const summary = updateRunReportInputFromResult(reportedResult, reportedRun);
    if (reportHints.nextAction) {
      summary.origin = { ...summary.origin, nextAction: reportHints.nextAction };
    }
    finalizeProgress?.finish(reportedRun);
    if (opts.json) {
      defaultRuntime.writeJson({
        ...reportedResult,
        ...(reportedRun ? { run: toPublicUpdateRun(reportedRun) } : {}),
      });
      return;
    }
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading(renderUpdateRunSummary(summary)));
    for (const warning of updateRunWarningMessages(summary.steps)) {
      defaultRuntime.log(`Warning: ${warning}`);
    }
    for (const owed of reportedRun ? listUpdateOwedSteps(reportedRun) : []) {
      defaultRuntime.log(`Warning: ${formatUpdateOwedStep(owed)}`);
    }
    // Cleanup states what it removed and kept even when nothing needs attention.
    for (const step of additionalSteps) {
      if (step.name === AUTOMATIC_RECOVERY_CLEANUP_STEP && step.diagnostics?.[0]) {
        defaultRuntime.log(step.diagnostics[0]);
      }
    }
  };
}

export async function printResult(...args: Parameters<typeof prepareResult>): Promise<void> {
  const emit = await prepareResult(...args);
  emit();
}
