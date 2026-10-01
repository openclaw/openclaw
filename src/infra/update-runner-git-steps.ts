import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { DEV_BRANCH } from "./update-channels.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions } from "./update-runner-types.js";

// A successful Git status command does not imply a clean checkout.
export async function runGitCleanCheckStep(options: RunStepOptions) {
  const result = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  const dirty = !isFailedUpdateStep(result) && Boolean(result.stdoutTail?.trim());
  if (dirty) {
    result.exitCode = 1;
    result.stderrTail = "This checkout has local changes. Installation has not started.";
  }
  options.progress?.onStepComplete?.({
    ...result,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return { result, dirty };
}

// Publish completion only after the owner classifies its recoverable result.
export async function runGitUpstreamStep(options: RunStepOptions) {
  const upstreamStep = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  if (
    typeof upstreamStep.exitCode === "number" &&
    upstreamStep.exitCode !== 0 &&
    !upstreamStep.signal &&
    !upstreamStep.killed &&
    !upstreamStep.outputLimitExceeded &&
    (!upstreamStep.termination || upstreamStep.termination === "exit") &&
    upstreamStep.exitCode !== 130 &&
    upstreamStep.exitCode !== 143
  ) {
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    upstreamStep.advisory = {
      kind: "recoverable-maintenance",
      message: `Skipped Git upstream tracking setup. Complete it with: git ${options.argv.slice(1).map(quote).join(" ")}. Reason: ${upstreamStep.stderrTail || "git branch failed"}`,
    };
  }
  options.progress?.onStepComplete?.({
    ...upstreamStep,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return upstreamStep;
}

export async function runGitActivationBranchCheckStep(stepOptions: RunStepOptions, branch: string) {
  const devBranchRef = `refs/heads/${branch}`;
  return runStep({
    ...stepOptions,
    runCommand: async (argv, options) => {
      const exists = await stepOptions.runCommand(
        ["git", "-C", stepOptions.cwd, "show-ref", "--verify", "--quiet", devBranchRef],
        options,
      );
      if (exists.code === 1) {
        return { ...exists, code: 0, stdout: "", stderr: "" };
      }
      if (exists.code !== 0) {
        return {
          ...exists,
          stdout: "",
          stderr: `Could not inspect local branch ${branch} before activation. Resolve the Git branch error, then rerun openclaw update.`,
        };
      }
      // Resetting a branch to its current ref is a ref/reflog no-op, but Git still
      // enforces every worktree owner state, including paused rebase and bisect.
      const result = await stepOptions.runCommand(argv, options);
      const sanitized = { ...result, stdout: "" };
      return result.code !== 0
        ? {
            ...sanitized,
            stderr:
              `Cannot activate this dev update because a Git worktree uses or reserves branch ${branch}. ` +
              `Finish or abort its rebase or bisect, or move it off ${branch}, then rerun openclaw update.`,
          }
        : sanitized;
    },
  });
}

export async function runGitRollbackSteps({
  beforeSha,
  branch,
  gitRoot,
  createdDevBranchDuringUpdate,
  sourceTreeStagingPaths,
  recoveryStep,
  checkSourceUnchanged,
  assertCurrent,
  activatedSource,
}: {
  beforeSha: string | null;
  branch: string | null;
  gitRoot: string;
  createdDevBranchDuringUpdate: boolean;
  sourceTreeStagingPaths: string[] | undefined;
  recoveryStep: (name: string, argv: string[], cwd: string) => RunStepOptions;
  checkSourceUnchanged: (
    sha: string,
    branch: string | null,
    assertCurrent: () => void,
  ) => Promise<{ status: "error"; reason: "clean-check-failed" | "dirty" } | undefined>;
  assertCurrent: () => void;
  activatedSource?: { sha: string; branch: string | null };
}) {
  if (!beforeSha) {
    return false;
  }
  let source = activatedSource;
  const assertSourceCurrent = async () => {
    assertCurrent();
    if (source && (await checkSourceUnchanged(source.sha, source.branch, assertCurrent))) {
      throw new Error("Git checkout changed after activation; retained rollback was refused.");
    }
    assertCurrent();
  };
  const execute = async (
    name: string,
    args: string[],
    expectedSource = source,
    refChange?: "keep" | "rewrite" | "detach",
  ) => {
    if (source) {
      await assertSourceCurrent();
    }
    assertCurrent();
    const stepOptions = recoveryStep(
      name,
      refChange === "keep" ? args : ["git", "-C", gitRoot, ...args],
      gitRoot,
    );
    const result = await runStep({
      ...stepOptions,
      progress: { ...stepOptions.progress, onStepComplete: undefined },
      runCommand: async (argv, options) => {
        assertCurrent();
        if (refChange === "keep") {
          return { code: 0, stdout: "", stderr: "" };
        }
        const commandResult = await stepOptions.runCommand(argv, options);
        if (refChange === "rewrite" && source && branch && commandResult.code === 0) {
          const ref = `refs/heads/${branch}`;
          const previous = await stepOptions.runCommand(
            ["git", "-C", gitRoot, "rev-parse", "--verify", `${ref}@{1}`],
            options,
          );
          const current = await stepOptions.runCommand(
            ["git", "-C", gitRoot, "rev-parse", "--verify", ref],
            options,
          );
          assertCurrent();
          const previousSha = previous.code === 0 ? previous.stdout.trim() : undefined;
          const currentSha = current.code === 0 ? current.stdout.trim() : undefined;
          if (previousSha !== source.sha || currentSha !== beforeSha) {
            const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
            const recovery =
              currentSha === beforeSha && previousSha && previousSha !== source.sha
                ? `After inspecting the reflog and preserving local edits, detach with: git checkout --detach --no-overwrite-ignore. If the branch still points to ${beforeSha}, restore the intended ref with: git branch -f ${quote(branch)} ${previousSha}`
                : `Inspect git reflog ${quote(branch)} and keep the newest intended commit.`;
            return {
              ...commandResult,
              code: 1,
              stderr: `Cannot verify rollback branch transition: expected ${source.sha} -> ${beforeSha}, observed ${previousSha || "unavailable reflog"} -> ${currentSha || "unreadable ref"}. Previous runtime retained. ${recovery}`,
            };
          }
        }
        return commandResult;
      },
    });
    if (refChange === "keep" && activatedSource) {
      const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
      result.advisory = {
        kind: "recoverable-maintenance",
        message: `Kept branch ${DEV_BRANCH} created by this update at ${activatedSource.sha}. Once no worktree uses it, remove it with: git branch -d ${quote(DEV_BRANCH)}`,
      };
    } else if (refChange === "detach" && source && branch && !isFailedUpdateStep(result)) {
      const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
      const git = `git -C ${quote(gitRoot)}`;
      result.advisory = {
        kind: "recoverable-maintenance",
        message: `Restored ${quote(gitRoot)} to ${beforeSha} on a detached HEAD; branch ${quote(branch)} still points to ${source.sha} because it has no reflog to verify a rollback rewrite. Once no worktree uses it, restore it with: ${git} update-ref ${quote(`refs/heads/${branch}`)} ${beforeSha} ${source.sha}, then ${git} switch ${quote(branch)}. Enable reflogs with: ${git} config core.logAllRefUpdates true`,
      };
    }
    stepOptions.progress?.onStepComplete?.({
      ...result,
      index: stepOptions.stepIndex,
      total: stepOptions.totalSteps,
    });
    assertCurrent();
    if (source) {
      if (isFailedUpdateStep(result)) {
        throw new Error(
          `Git source rollback failed at ${name}; previous runtime retained.${result.stderrTail ? ` ${result.stderrTail}` : ""}`,
        );
      }
      // Advance only to the command's planned result, never a fresh snapshot
      // that could adopt operator edits made while the child was running.
      source = expectedSource;
      await assertSourceCurrent();
    }
    return result;
  };
  const restore = async (
    name: string,
    args: string[],
    expectedSource = source,
    refChange?: "keep" | "rewrite" | "detach",
  ) => !isFailedUpdateStep(await execute(name, args, expectedSource, refChange));
  // A retained transaction admitted a clean source tree. It owns no dirty
  // files to reset or clean, even if they appear after its last observation.
  let restored = true;
  if (!source) {
    restored = await restore("git-rollback-clean", ["reset", "--hard"]);
    restored =
      (await restore("git-rollback-clean-untracked", [
        "clean",
        "-fd",
        "-e",
        "dist/control-ui/",
        ...(sourceTreeStagingPaths?.flatMap((relative) => ["-e", `/${relative}/`]) ?? []),
      ])) && restored;
  }
  const attached = branch && branch !== "HEAD";
  const checkedOut = await restore(
    "git-rollback-checkout",
    attached
      ? ["checkout", source ? "--no-overwrite-ignore" : "--force", branch]
      : ["checkout", "--detach", ...(source ? ["--no-overwrite-ignore"] : []), beforeSha],
    source
      ? {
          sha: attached && branch === source.branch ? source.sha : beforeSha,
          branch: attached ? branch : "HEAD",
        }
      : undefined,
  );
  if (attached && checkedOut) {
    if (source) {
      if (source.sha !== beforeSha) {
        const { runCommand, cwd, timeoutMs } = recoveryStep("git-rollback-source", [], gitRoot);
        const options = { cwd, timeoutMs };
        const ref = `refs/heads/${branch}`;
        const reflog = await runCommand(["git", "-C", gitRoot, "reflog", "exists", ref], options);
        assertCurrent();
        const latest =
          reflog.code === 0
            ? await runCommand(
                ["git", "-C", gitRoot, "rev-parse", "--verify", `${ref}@{0}`],
                options,
              )
            : reflog;
        assertCurrent();
        const rewrite = latest.code === 0 && Boolean(latest.stdout.trim());
        // Stay attached for branch custody; porcelain also protects ignored files.
        // checkout -B lacks CAS, so execute verifies its reflog transition afterward.
        // Without a reflog, detaching writes no branch ref yet restores every tracked input.
        await restore(
          "git-rollback-source",
          rewrite
            ? ["checkout", "--no-overwrite-ignore", "-B", branch, beforeSha]
            : ["checkout", "--detach", "--no-overwrite-ignore", beforeSha],
          { sha: beforeSha, branch: rewrite ? branch : "HEAD" },
          rewrite ? "rewrite" : "detach",
        );
      }
    } else {
      restored = (await restore("git-rollback-reset", ["reset", "--hard", beforeSha])) && restored;
    }
  }
  if (createdDevBranchDuringUpdate && (!attached || checkedOut)) {
    if (activatedSource) {
      // Git cannot exclude in-flight worktree claims, so retained rollback keeps the ref.
      await execute("git-rollback-keep-branch", ["keep", "branch", DEV_BRANCH], source, "keep");
    } else {
      await restore("git-rollback-delete-branch", ["branch", "-D", DEV_BRANCH]);
    }
  }
  const head = await execute("git-rollback-verify-head", ["rev-parse", "HEAD"]);
  const verified = !isFailedUpdateStep(head) && head.stdoutTail?.trim() === beforeSha;
  head.exitCode = verified ? 0 : 1;
  if (!verified) {
    head.stderrTail = `expected ${beforeSha}, found ${head.stdoutTail?.trim() || "unreadable HEAD"}`;
  }
  return restored && checkedOut && verified;
}
