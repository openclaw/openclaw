import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { runStep } from "./update-runner-command.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import type { CommandRunner } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

// The installed updater owns this entrypoint; candidate code only runs inside its build unit.
async function build(): Promise<void> {
  const [stage, sha, deadline, workDeadline = "0"] = process.argv.slice(2);
  if (!stage || !sha || !/^[a-f0-9]{40}$/u.test(sha) || process.geteuid?.() === 0) {
    throw new Error(
      "Immutable builds require a private stage, exact SHA and unprivileged account.",
    );
  }
  const timeoutMs = Number(deadline);
  const workTimeoutMs = Number(workDeadline);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(workTimeoutMs) ||
    workTimeoutMs < 0
  ) {
    throw new Error("Invalid immutable build command deadline.");
  }
  const runCommand: CommandRunner = (argv, options) =>
    runCommandWithTimeout(argv, { ...options, killProcessTree: true });
  const steps: UpdateStepResult[] = [];
  const step: StepFactory = (name, argv, cwd, env) => ({
    name,
    argv,
    cwd,
    env,
    runCommand,
    timeoutMs,
    stepIndex: 0,
    totalSteps: 0,
    results: steps,
  });
  const command = async (name: string, argv: string[], cwd: string) => {
    const result = await runStep(step(name, argv, cwd));
    if (result.exitCode !== 0 || (result.termination && result.termination !== "exit")) {
      throw new Error(`${name} failed: ${result.stderrTail ?? ""}`);
    }
  };
  const source = path.join(stage, "source");
  await command(
    "immutable-clone",
    [
      "git",
      "clone",
      "--no-checkout",
      "--single-branch",
      "--branch",
      "main",
      "https://github.com/openclaw/openclaw.git",
      source,
    ],
    stage,
  );
  await command(
    "immutable-official-ancestry",
    ["git", "-C", source, "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
    source,
  );
  const preflight = await runGitCandidatePreflight({
    gitRoot: source,
    artifactRoot: stage,
    targetRevision: sha,
    refreshedRemotes: ["origin"],
    beforeRuntimeVerified: false,
    frozenLockfile: true,
    needsCheckoutMain: false,
    runCommand,
    timeoutMs,
    defaultCommandEnv: process.env,
    steps,
    step,
    workStep: step,
    workTimeoutMs: workTimeoutMs || undefined,
    beforeCandidate: async (selected) => {
      if (selected !== sha) {
        throw new Error("Immutable preparation cannot fall back to another commit.");
      }
    },
    validateCandidate: async (root) => {
      const errors = await collectGitRuntimeErrors({ root, sha });
      if (errors.length) {
        throw new Error(errors.join("; "));
      }
    },
    prepareCandidate: async (built) => {
      const candidate = path.join(stage, "generation");
      await command(
        "immutable-independent-git",
        ["git", "clone", "--no-hardlinks", "--no-checkout", source, candidate],
        stage,
      );
      await command(
        "immutable-exact-checkout",
        ["git", "-C", candidate, "checkout", "--detach", sha],
        candidate,
      );
      await fs.cp(built, candidate, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (file) => file !== path.join(built, ".git"),
      });
    },
  });
  if (preflight.status !== "ok") {
    const failed = steps.findLast(
      (entry) => entry.exitCode !== 0 || (entry.termination && entry.termination !== "exit"),
    );
    throw new Error(
      `${preflight.reason}${failed ? `: ${failed.name}: ${failed.stderrTail ?? ""}` : ""}`,
    );
  }
}

void build().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Immutable build failed"}\n`);
  process.exitCode = 1;
});
