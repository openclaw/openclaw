import { createUpdateFailureFact } from "./update-failure-facts.js";
import { classifyPreflightFailure, type StepFactory } from "./update-runner-git-commands.js";
import { abortGitPreflightRebase, isInterruptedGitStep } from "./update-runner-git-steps.js";
import type { CommandRunner } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

export const LOCAL_REPLAY_CONFLICT_REASON = "preflight-local-replay-conflict";
// Bounds the object-name arguments of one comparison; larger conflicts are replayed.
const REPLAY_CONFLICT_COMPARE_MAX_PATHS = 64;

type ReplayConflictGit = { worktreeDir: string; runCommand: CommandRunner; timeoutMs: number };

type ReplayProbeResult = Awaited<ReturnType<CommandRunner>>;

const isInterruptedProbe = (result: ReplayProbeResult) =>
  result.termination === "signal" ||
  Boolean(result.signal) ||
  result.code === 130 ||
  result.code === 143;

/**
 * Read the paused rebase before it is aborted, and name the conflict on its step.
 * Runner errors propagate to the preflight owner; null means a probe was interrupted.
 */
async function readReplayConflictPaths(
  params: ReplayConflictGit,
  rebase: UpdateStepResult,
): Promise<string[] | null> {
  const git = ["git", "-C", params.worktreeDir];
  const options = { cwd: params.worktreeDir, timeoutMs: params.timeoutMs };
  const unmerged = await params.runCommand(
    [...git, "diff", "--name-only", "--diff-filter=U", "-z"],
    options,
  );
  if (isInterruptedProbe(unmerged)) {
    return null;
  }
  const paths = unmerged.code === 0 ? unmerged.stdout.split("\0").filter(Boolean) : [];
  if (paths.length === 0) {
    return [];
  }
  const commit = await params.runCommand(
    [...git, "rev-parse", "--short", "--verify", "--quiet", "REBASE_HEAD"],
    options,
  );
  if (isInterruptedProbe(commit)) {
    return null;
  }
  const sha = commit.code === 0 ? commit.stdout.trim() : "";
  const check = rebase.name;
  rebase.failureFacts = [
    {
      check,
      code: LOCAL_REPLAY_CONFLICT_REASON,
      message: `${sha ? `Local commit ${sha}` : "A local commit"} conflicts with the update target in ${paths.length} path(s): ${paths.join(", ")}`,
    },
    ...paths
      .slice(0, 4)
      .map((affectedKey) => ({ check, code: LOCAL_REPLAY_CONFLICT_REASON, affectedKey })),
  ].map((fact) => createUpdateFailureFact(fact));
  return paths;
}

/**
 * An older candidate whose objects at every conflicted path equal the conflicted
 * candidate's meets the same conflict. A path that does not resolve in either
 * revision (rename, delete, add) proves nothing, so that candidate is replayed.
 */
export async function hasSameReplayConflictObjects(
  params: ReplayConflictGit,
  conflict: { sha: string; paths: string[] },
  sha: string,
): Promise<boolean> {
  const { paths } = conflict;
  if (paths.length === 0 || paths.length > REPLAY_CONFLICT_COMPARE_MAX_PATHS) {
    return false;
  }
  const result = await params.runCommand(
    [
      "git",
      "-C",
      params.worktreeDir,
      "rev-parse",
      ...[conflict.sha, sha].flatMap((revision) => paths.map((file) => `${revision}:${file}`)),
    ],
    { cwd: params.worktreeDir, timeoutMs: params.timeoutMs },
  );
  const objects = result.code === 0 ? result.stdout.trim().split(/\s+/u) : [];
  return (
    objects.length === paths.length * 2 &&
    paths.every((_, index) => {
      const object = objects[index];
      return Boolean(object) && object === objects[index + paths.length];
    })
  );
}

/** Replay local commits onto a checked-out candidate; null means the replay applied. */
export async function replayLocalCommits(
  params: ReplayConflictGit & {
    sha: string;
    rebaseFrom: string;
    referenceSource?: unknown;
    step: StepFactory;
    runCandidateCheck: (name: string, argv: string[]) => Promise<UpdateStepResult | null>;
  },
): Promise<{
  status: "failed" | "insufficient-space" | "stopped" | "replay-timeout";
  /** Paths Git left unmerged when replaying local commits onto this candidate. */
  replayConflictPaths?: string[];
} | null> {
  const git = ["git", "-C", params.worktreeDir];
  const source = await params.runCandidateCheck("local-checkout", [
    ...git,
    "checkout",
    "--detach",
    params.rebaseFrom,
  ]);
  const rebase =
    source ??
    (await params.runCandidateCheck("rebase", [
      ...git,
      "rebase",
      ...(params.referenceSource ? ["--rebase-merges"] : []),
      params.sha,
    ]));
  if (!rebase) {
    return null;
  }
  // Only an ordinary rebase exit leaves a paused conflict worth describing.
  const replayConflictPaths =
    !source &&
    !params.referenceSource &&
    !isInterruptedGitStep(rebase) &&
    !rebase.killed &&
    !rebase.outputLimitExceeded &&
    (!rebase.termination || rebase.termination === "exit")
      ? await readReplayConflictPaths(params, rebase)
      : [];
  if (
    !replayConflictPaths ||
    isInterruptedGitStep(rebase) ||
    (!source &&
      (await abortGitPreflightRebase(
        params.step("preflight-rebase-abort", [...git, "rebase", "--abort"], params.worktreeDir),
      )))
  ) {
    return { status: "stopped" };
  }
  const failure = classifyPreflightFailure(rebase);
  if (failure === "insufficient-space") {
    return { status: failure };
  }
  if (
    !params.referenceSource &&
    (rebase.termination === "timeout" || rebase.termination === "no-output-timeout")
  ) {
    return { status: "replay-timeout" };
  }
  return {
    status: failure,
    ...(replayConflictPaths.length > 0 ? { replayConflictPaths } : {}),
  };
}
