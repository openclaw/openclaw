import { spinner } from "@clack/prompts";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import type {
  UpdateRunResult,
  UpdateStepCompletion,
  UpdateStepProgress,
} from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";
import type { UpdateCommandOptions } from "./shared.js";

const STEP_LABELS: Record<string, string> = {
  "clean check": "Working directory is clean",
  "upstream check": "Upstream branch exists",
  "git fetch": "Fetching latest changes",
  "git rebase": "Rebasing onto target commit",
  "git rev-parse @{upstream}": "Resolving upstream commit",
  "git rev-list": "Enumerating candidate commits",
  "git clone": "Cloning git checkout",
  "preflight worktree": "Preparing preflight worktree",
  "preflight cleanup": "Cleaning preflight worktree",
  "deps install": "Installing dependencies",
  build: "Building",
  "ui:build": "Building UI assets",
  "ui:build (post-doctor repair)": "Restoring missing UI assets",
  "ui assets verify": "Validating UI assets",
  "openclaw doctor entry": "Checking doctor entrypoint",
  "openclaw doctor": "Running doctor checks",
  "git rev-parse HEAD (after)": "Verifying update",
  "global update": "Updating via package manager",
  "global update (omit optional)": "Retrying update without optional deps",
  "global install stage": "Preparing staged package install",
  "global install verify": "Verifying global package",
  "global install swap": "Activating global package",
  "global install": "Installing global package",
};

function getStepLabel(step: { name: string }): string {
  return STEP_LABELS[step.name] ?? step.name;
}

export type StepDisplayOutcome = "ok" | "warn" | "fail";

export type StepDisplay = {
  label: string;
  outcome: StepDisplayOutcome;
};

type StepDisplayInput = Pick<UpdateStepCompletion, "name" | "exitCode"> & {
  stdoutTail?: string | null;
};

export function resolveStepDisplay(step: StepDisplayInput): StepDisplay {
  // `git status --porcelain` exits 0 whether the tree is clean or dirty.
  // Treat any non-empty stdout as a dirty tree so we don't claim success.
  if (step.name === "clean check" && step.exitCode === 0) {
    const dirty = (step.stdoutTail ?? "").trim().length > 0;
    if (dirty) {
      return { label: "Working directory has uncommitted changes", outcome: "warn" };
    }
  }
  if (step.exitCode === 0) {
    return { label: getStepLabel(step), outcome: "ok" };
  }
  return { label: getStepLabel(step), outcome: "fail" };
}

export function inferUpdateFailureHints(result: UpdateRunResult): string[] {
  if (result.status !== "error") {
    return [];
  }
  if (result.reason === "pnpm-corepack-missing") {
    return [
      "This pnpm checkout could not auto-enable pnpm because corepack is missing.",
      "Install pnpm manually or install Node with corepack available, then rerun the update command.",
    ];
  }
  if (result.reason === "pnpm-corepack-enable-failed") {
    return [
      "This pnpm checkout could not auto-enable pnpm via corepack.",
      "Run `corepack enable` manually or install pnpm manually, then rerun the update command.",
    ];
  }
  if (result.reason === "pnpm-npm-bootstrap-failed") {
    return [
      "This pnpm checkout could not bootstrap pnpm from npm automatically.",
      "Install pnpm manually, then rerun the update command.",
    ];
  }
  if (result.reason === "preferred-manager-unavailable") {
    return [
      "This checkout requires its declared package manager and the updater could not find it.",
      "Install the missing package manager manually, then rerun the update command.",
    ];
  }
  if (result.mode !== "npm") {
    return [];
  }
  const failedStep = [...result.steps].toReversed().find((step) => step.exitCode !== 0);
  if (!failedStep) {
    return [];
  }

  const stderr = normalizeLowercaseStringOrEmpty(failedStep.stderrTail);
  const hints: string[] = [];
  const isGlobalPackageInstallStep =
    failedStep.name.startsWith("global update") || failedStep.name.startsWith("global install");

  if (isGlobalPackageInstallStep && stderr.includes("eacces")) {
    hints.push(
      "Detected permission failure (EACCES). Re-run with a writable global prefix or sudo (for system-managed Node installs).",
    );
    hints.push("Example: npm config set prefix ~/.local && npm i -g openclaw@latest");
  }

  if (
    failedStep.name.startsWith("global update") &&
    (stderr.includes("node-gyp") || stderr.includes("prebuild"))
  ) {
    hints.push(
      "Detected native optional dependency build failure. The updater retries with --omit=optional automatically.",
    );
    hints.push("If it still fails: npm i -g openclaw@latest --omit=optional");
  }

  return hints;
}

export type ProgressController = {
  progress: UpdateStepProgress;
  stop: () => void;
};

export function createUpdateProgress(enabled: boolean): ProgressController {
  if (!enabled) {
    return {
      progress: {},
      stop: () => {},
    };
  }

  let currentSpinner: ReturnType<typeof spinner> | null = null;

  const progress: UpdateStepProgress = {
    onStepStart: (step) => {
      currentSpinner = spinner();
      currentSpinner.start(theme.accent(getStepLabel(step)));
    },
    onStepComplete: (step) => {
      if (!currentSpinner) {
        return;
      }

      const display = resolveStepDisplay(step);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      const icon =
        display.outcome === "ok"
          ? theme.success("\u2713")
          : display.outcome === "warn"
            ? theme.warn("\u2717")
            : theme.error("\u2717");

      currentSpinner.stop(`${icon} ${display.label} ${duration}`);
      currentSpinner = null;

      if (display.outcome === "warn" && step.stdoutTail) {
        const lines = step.stdoutTail.split("\n").slice(0, 10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.warn(line)}`);
          }
        }
      }

      if (display.outcome === "fail" && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(-10);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`    ${theme.error(line)}`);
          }
        }
      }
    },
  };

  return {
    progress,
    stop: () => {
      if (currentSpinner) {
        currentSpinner.stop();
        currentSpinner = null;
      }
    },
  };
}

function formatStepStatus(outcome: StepDisplayOutcome | "pending"): string {
  if (outcome === "ok") {
    return theme.success("\u2713");
  }
  if (outcome === "pending") {
    return theme.warn("?");
  }
  if (outcome === "warn") {
    return theme.warn("\u2717");
  }
  return theme.error("\u2717");
}

type PrintResultOptions = UpdateCommandOptions & {
  hideSteps?: boolean;
};

export function printResult(result: UpdateRunResult, opts: PrintResultOptions): void {
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }

  const statusColor =
    result.status === "ok" ? theme.success : result.status === "skipped" ? theme.warn : theme.error;

  defaultRuntime.log("");
  defaultRuntime.log(
    `${theme.heading("Update Result:")} ${statusColor(result.status.toUpperCase())}`,
  );
  if (result.root) {
    defaultRuntime.log(`  Root: ${theme.muted(result.root)}`);
  }
  if (result.reason) {
    defaultRuntime.log(`  Reason: ${theme.muted(result.reason)}`);
  }

  if (result.before?.version || result.before?.sha) {
    const before = result.before.version ?? result.before.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  Before: ${theme.muted(before)}`);
  }
  if (result.after?.version || result.after?.sha) {
    const after = result.after.version ?? result.after.sha?.slice(0, 8) ?? "";
    defaultRuntime.log(`  After: ${theme.muted(after)}`);
  }

  if (!opts.hideSteps && result.steps.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Steps:"));
    for (const step of result.steps) {
      const display =
        step.exitCode === null
          ? { label: step.name, outcome: "pending" as const }
          : resolveStepDisplay(step);
      const status = formatStepStatus(display.outcome);
      const duration = theme.muted(`(${formatDurationPrecise(step.durationMs)})`);
      defaultRuntime.log(`  ${status} ${display.label} ${duration}`);

      if (display.outcome === "warn" && step.stdoutTail) {
        const lines = step.stdoutTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.warn(line)}`);
          }
        }
      }

      if (display.outcome === "fail" && step.stderrTail) {
        const lines = step.stderrTail.split("\n").slice(0, 5);
        for (const line of lines) {
          if (line.trim()) {
            defaultRuntime.log(`      ${theme.error(line)}`);
          }
        }
      }
    }
  }

  const hints = inferUpdateFailureHints(result);
  if (hints.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Recovery hints:"));
    for (const hint of hints) {
      defaultRuntime.log(`  - ${theme.warn(hint)}`);
    }
  }

  defaultRuntime.log("");
  defaultRuntime.log(`Total time: ${theme.muted(formatDurationPrecise(result.durationMs))}`);
}
