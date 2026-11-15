import fs from "node:fs/promises";
import path from "node:path";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { gitReleaseSlot, resolveGitReleasePrefix } from "./git-release-paths.js";
import {
  collectGitReleases,
  createGitReleaseWorktreeDir,
  publishGitRelease,
} from "./git-release.js";
import { readPackageVersion } from "./package-json.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import {
  readBuiltGatewayBuildId,
  readGitRuntimeArtifactIdentity,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { resolveBuildEnv, resolveGitUpdateCommandEnv } from "./update-runner-git-commands.js";
import {
  fetchGitUpdateTarget,
  prepareGitMutation,
  readBranchName,
  selectGitInspectionTarget,
} from "./update-runner-git-target.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateRunnerOptions,
} from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

/**
 * Update a Git checkout install by building the target as a new release (a
 * detached worktree of the checkout) and switching the release link to it. The
 * checkout and the running release are never written; the Gateway that starts
 * from the new release upgrades state at boot. On the first update the current
 * HEAD becomes the first release, so a failed trial has somewhere to go back to.
 */
export async function updateGitRelease(params: {
  opts: UpdateRunnerOptions;
  gitRoot: string;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  startedAt: number;
}): Promise<UpdateRunResult> {
  const { opts, gitRoot, timeoutMs, startedAt } = params;
  const defaultCommandEnv = resolveGitUpdateCommandEnv(params.defaultCommandEnv);
  const runCommand = params.runCommand;
  const channel: UpdateChannel = opts.channel ?? "dev";
  const steps: UpdateStepResult[] = [];
  const prefix = resolveGitReleasePrefix();
  const slot = gitReleaseSlot(prefix);
  const converting = !readPackageReleaseSlotSync(slot);
  const totalSteps = converting ? 10 : 8;
  let stepIndex = 0;
  const forRunner =
    (deadline: number | undefined) =>
    (name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): RunStepOptions => ({
      runCommand,
      name,
      argv,
      cwd,
      timeoutMs: deadline,
      env,
      progress: opts.progress,
      stepIndex: stepIndex++,
      totalSteps,
      results: steps,
    });
  const step = forRunner(timeoutMs);
  const workStep = forRunner(opts.timeoutMs);
  const head = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
    cwd: gitRoot,
    timeoutMs,
  });
  const beforeSha = head.stdout.trim() || null;
  const [beforeVersion, beforeBuildId] = await Promise.all([
    readPackageVersion(gitRoot),
    readBuiltGatewayBuildId(gitRoot),
  ]);
  const before = {
    sha: beforeSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  // The running release and the checkout stay untouched until the link moves.
  const recovery = await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
  const result = (
    status: UpdateRunResult["status"],
    reason?: string,
    extra: Partial<UpdateRunResult> = {},
  ): UpdateRunResult => ({
    status,
    mode: "git",
    root: converting ? gitRoot : slot,
    ...(reason ? { reason } : {}),
    before,
    recovery,
    steps,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
  if (channel === "extended-stable") {
    return result("error", "unsupported_git_channel");
  }
  if (head.code !== 0 || !beforeSha) {
    return result("error", "git-root-unresolved");
  }

  const fetched = await fetchGitUpdateTarget({
    root: gitRoot,
    step,
    workStep,
    name: "git-fetch",
    channel,
    devTarget: opts.devTarget,
    steps,
  });
  if (!fetched.ok) {
    return result("error", fetched.reason ?? "fetch-failed");
  }

  const discard = async (worktreeDir: string) => {
    await runCommand(
      ["git", "-C", gitRoot, "worktree", "remove", "--force", "--force", worktreeDir],
      {
        cwd: gitRoot,
        timeoutMs,
      },
    ).catch(() => undefined);
    await fs.rm(path.dirname(path.dirname(path.dirname(worktreeDir))), {
      recursive: true,
      force: true,
    });
  };

  // The first release is the code that runs now; it has no trial.
  let previousRelease: string | undefined;
  if (converting) {
    const worktreeDir = await createGitReleaseWorktreeDir(prefix, beforeSha);
    const env = resolveBuildEnv(
      defaultCommandEnv ?? process.env,
      path.join(prefix, ".build-cache"),
    );
    const failed = [
      [
        "git-release-current",
        ["git", "-C", gitRoot, "worktree", "add", "--detach", worktreeDir, beforeSha],
      ],
      ["git-release-current-install", ["pnpm", "install", "--frozen-lockfile"]],
      ["git-release-current-build", ["pnpm", "build"]],
    ] as const;
    for (const [name, argv] of failed) {
      const outcome = await runStep(
        workStep(name, [...argv], name === "git-release-current" ? gitRoot : worktreeDir, env),
      );
      if (isFailedUpdateStep(outcome)) {
        await discard(worktreeDir);
        return result("error", "git-release-current-failed");
      }
    }
    if ((await resolveControlUiAssetHealth({ root: worktreeDir })).kind !== "ready") {
      const ui = await runStep(
        workStep("git-release-current-ui", ["pnpm", "ui:build"], worktreeDir, env),
      );
      if (isFailedUpdateStep(ui)) {
        await discard(worktreeDir);
        return result("error", "git-release-current-failed");
      }
    }
    await publishGitRelease({ prefix, releaseRoot: worktreeDir, trial: false });
    previousRelease = worktreeDir;
  }

  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const worktreeDir = await createGitReleaseWorktreeDir(prefix, "git");
  let cleanup: (() => Promise<boolean>) | undefined;
  const preflight = await selectGitInspectionTarget({
    gitRoot,
    artifactRoot: prefix,
    release: { prefix: path.dirname(path.dirname(path.dirname(worktreeDir))), worktreeDir },
    frozenLockfile: true,
    channel,
    devTarget: opts.devTarget,
    refreshedRemotes: fetched.refreshedRemotes,
    devSource: fetched.devSource,
    beforeSha,
    beforeRuntimeVerified: true,
    sourceRuntimePrepared: opts.sourceRuntimePrepared,
    beforeGitStaging: opts.beforeGitStaging,
    validateCandidate: opts.validateCandidate,
    retainCleanup: (retained) => {
      cleanup = retained;
      return true;
    },
    needsCheckoutMain: channel === "dev" && !opts.devTarget && branch !== DEV_BRANCH,
    runCommand,
    timeoutMs,
    defaultCommandEnv,
    steps,
    step,
    workStep,
    workTimeoutMs: opts.timeoutMs,
    beforeCandidate: (revision) =>
      prepareGitMutation({
        runCommand,
        root: gitRoot,
        revision,
        timeoutMs,
        beforeGitMutation: opts.inspectGitTarget,
      }),
  }).catch(async (error: unknown) => {
    await cleanup?.();
    throw error;
  });
  if (preflight.status !== "ok") {
    await cleanup?.();
    // A converted install that is already current switches to its first release.
    if (!previousRelease || preflight.reason !== "already-current") {
      return result(preflight.status, preflight.reason);
    }
  }
  const releaseRoot = preflight.status === "ok" ? worktreeDir : previousRelease!;
  const version = await readPackageVersion(releaseRoot);
  // The service's Node must load the release before the link names it.
  const smoke = await runStep(
    step(
      "git-release-smoke",
      [opts.releaseNode ?? process.execPath, path.join(releaseRoot, "openclaw.mjs"), "--version"],
      releaseRoot,
      defaultCommandEnv,
    ),
  );
  if (isFailedUpdateStep(smoke) || (version && !smoke.stdoutTail?.includes(version))) {
    await cleanup?.();
    return result("error", "git-release-smoke-failed");
  }
  const afterSha = preflight.status === "ok" ? preflight.candidateSha : beforeSha;
  await prepareGitMutation({
    runCommand,
    root: gitRoot,
    revision: afterSha,
    timeoutMs,
    beforeGitMutation: opts.beforeGitMutation,
  });
  if (preflight.status === "ok") {
    await publishGitRelease({ prefix, releaseRoot, trial: true });
  }
  const collected = await collectGitReleases({
    prefix,
    keep: [releaseRoot, ...(previousRelease ? [previousRelease] : [])],
    prune: () =>
      runCommand(["git", "-C", gitRoot, "worktree", "prune"], { cwd: gitRoot, timeoutMs }),
  }).catch((error: unknown) => ({ removed: [], warnings: [String(error)] }));
  const afterBuildId = await readBuiltGatewayBuildId(releaseRoot);
  return {
    ...result("ok", undefined, {
      root: slot,
      gitRuntime: await readGitRuntimeArtifactIdentity(releaseRoot),
      sourceRuntimePrepared: true,
      after: {
        sha: afterSha,
        version,
        ...(afterBuildId ? { buildId: afterBuildId } : {}),
        ...(opts.devTarget?.mode === "tracked" ? { upstreamRef: opts.devTarget.upstreamRef } : {}),
      },
    }),
    ...(collected.warnings.length > 0
      ? {
          steps: [
            ...steps,
            {
              name: "git-release-collect",
              command: "collect releases",
              cwd: prefix,
              durationMs: 0,
              exitCode: 0,
              advisory: { kind: "recoverable-maintenance", message: collected.warnings.join(" ") },
            },
          ],
        }
      : {}),
  };
}
