import path from "node:path";
import { gitReleaseSlot, resolveGitReleasePrefix } from "./git-release-paths.js";
import { collectGitReleases, createGitReleaseDirs, publishGitRelease } from "./git-release.js";
import { readPackageVersion } from "./package-json.js";
import { readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import {
  readBuiltGatewayBuildId,
  readBuiltRuntimeCommit,
  readGitRuntimeArtifactIdentity,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { resolveGitUpdateCommandEnv } from "./update-runner-git-commands.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
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
 * from the new release upgrades state at boot. The first update also builds the
 * current HEAD as the first release, so a failed trial has somewhere to go back to.
 */
export async function updateGitRelease(params: {
  opts: UpdateRunnerOptions;
  gitRoot: string;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  startedAt: number;
}): Promise<UpdateRunResult> {
  const { opts, timeoutMs, startedAt, runCommand } = params;
  const defaultCommandEnv = resolveGitUpdateCommandEnv(params.defaultCommandEnv);
  const channel: UpdateChannel = opts.channel ?? "dev";
  const steps: UpdateStepResult[] = [];
  const prefix = resolveGitReleasePrefix();
  const slot = gitReleaseSlot(prefix);
  const converting = !readPackageReleaseSlotSync(slot);
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
      totalSteps: converting ? 12 : 9,
      results: steps,
    });
  const step = forRunner(timeoutMs);
  const workStep = forRunner(opts.timeoutMs);
  // A release is a worktree of the developer's checkout; Git work happens there.
  // The selected release serves, even when this CLI runs from the preserved checkout.
  const running = converting ? params.gitRoot : slot;
  const git = (root: string, ...args: string[]) =>
    runCommand(["git", "-C", root, ...args], { cwd: root, timeoutMs });
  const commonDir = (
    await git(running, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).stdout.trim();
  const gitRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : params.gitRoot;
  // A checkout serves what its dist was built from, which can trail a pulled HEAD; the
  // first release, the trial's fallback, must be that serving commit.
  const builtCommit = converting ? await readBuiltRuntimeCommit(running) : null;
  const runningHead = await git(
    running,
    "rev-parse",
    "--verify",
    `${builtCommit ?? "HEAD"}^{commit}`,
  );
  const head = await git(gitRoot, "rev-parse", "HEAD");
  const runningSha = runningHead.stdout.trim() || null;
  const beforeSha = head.stdout.trim() || null;
  const [beforeVersion, beforeBuildId] = await Promise.all([
    readPackageVersion(running),
    readBuiltGatewayBuildId(running),
  ]);
  const before = {
    sha: runningSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  // The running release and the checkout stay untouched until the link moves.
  const recovery = await verifyGitUpdateRecovery({ root: running, sha: runningSha });
  const result = (status: UpdateRunResult["status"], reason?: string): UpdateRunResult => ({
    status,
    mode: "git",
    root: converting ? gitRoot : slot,
    ...(reason ? { reason } : {}),
    before,
    recovery,
    // A release is built where it stays; nothing regenerates runtime inside it later.
    sourceRuntimePrepared: true,
    steps,
    durationMs: Date.now() - startedAt,
  });
  if (channel === "extended-stable") {
    return result("error", "unsupported_git_channel");
  }
  if (head.code !== 0 || !beforeSha || !runningSha) {
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

  // Node refuses to strip types under node_modules, and the build runs .mts
  // scripts, so a release is built beside its final path and moved into place.
  const buildRelease = async (
    select: (
      release: Parameters<typeof runGitCandidatePreflight>[0]["release"] & {},
      common: Omit<
        Parameters<typeof runGitCandidatePreflight>[0],
        "release" | "beforeRuntimeVerified" | "validateCandidate" | "beforeCandidate"
      >,
      retainCleanup: (cleanup: () => Promise<boolean>) => boolean,
    ) => ReturnType<typeof runGitCandidatePreflight>,
  ) => {
    const dirs = await createGitReleaseDirs(prefix);
    let cleanup: (() => Promise<boolean>) | undefined;
    const common = {
      gitRoot,
      artifactRoot: prefix,
      frozenLockfile: true,
      refreshedRemotes: fetched.refreshedRemotes,
      devSource: fetched.devSource,
      beforeSha,
      sourceRuntimePrepared: opts.sourceRuntimePrepared,
      needsCheckoutMain: false,
      runCommand,
      timeoutMs,
      defaultCommandEnv,
      steps,
      step,
      workStep,
      workTimeoutMs: opts.timeoutMs,
    };
    const built = await select(
      { prefix: dirs.releasePrefix, worktreeDir: dirs.buildDir },
      common,
      (retained) => {
        cleanup = retained;
        return true;
      },
    ).catch(async (error: unknown) => {
      await cleanup?.();
      throw error;
    });
    if (built.status !== "ok") {
      await cleanup?.();
      return built;
    }
    // Replayed local commits get new IDs on every rebuild; the same tree is the same release.
    const [builtTree, runningTree] = await Promise.all(
      [built.candidateSha, runningSha].map(
        async (sha) => (await git(gitRoot, "rev-parse", `${sha}^{tree}`)).stdout.trim() || sha,
      ),
    );
    if (!converting && recovery.serviceRestartSafe && builtTree === runningTree) {
      await cleanup?.();
      return { status: "skipped" as const, reason: "already-current" as const };
    }
    const moved = await runStep(
      step(
        "git-release-place",
        ["git", "-C", gitRoot, "worktree", "move", dirs.buildDir, dirs.releaseRoot],
        gitRoot,
      ),
    );
    if (isFailedUpdateStep(moved)) {
      await cleanup?.();
      return { status: "error" as const, reason: "git-release-place-failed" };
    }
    return { ...built, releaseRoot: dirs.releaseRoot };
  };

  // The first release is the code that runs now. It is not a candidate: it runs already.
  let previousRelease: string | undefined;
  if (converting) {
    const current = await buildRelease((release, common, retainCleanup) =>
      runGitCandidatePreflight({
        ...common,
        release,
        retainCleanup,
        // The fallback is the code that serves now, which can differ from the checkout's HEAD.
        targetRevision: runningSha,
        beforeRuntimeVerified: false,
        validateCandidate: async () => [],
        beforeCandidate: async () => {},
      }),
    );
    if (current.status !== "ok") {
      return result("error", `git-release-current-failed: ${current.reason}`);
    }
    await publishGitRelease({ prefix, releaseRoot: current.releaseRoot, trial: false });
    previousRelease = current.releaseRoot;
  }

  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const target = await buildRelease((release, common, retainCleanup) =>
    selectGitInspectionTarget({
      ...common,
      release,
      retainCleanup,
      channel,
      devTarget: opts.devTarget,
      // Same source is current only when the running release's artifacts verify (#158931).
      // A conversion from a linked worktree can serve a different commit than the checkout.
      beforeRuntimeVerified: recovery.serviceRestartSafe && beforeSha === runningSha,
      beforeGitStaging: opts.beforeGitStaging,
      validateCandidate: opts.validateCandidate,
      needsCheckoutMain: channel === "dev" && !opts.devTarget && branch !== DEV_BRANCH,
      beforeCandidate: (revision) =>
        prepareGitMutation({
          runCommand,
          root: gitRoot,
          revision,
          timeoutMs,
          beforeGitMutation: opts.inspectGitTarget,
        }),
    }),
  );
  if (target.status !== "ok" && (!previousRelease || target.reason !== "already-current")) {
    return result(target.status, target.reason);
  }
  // A converted install that is already current keeps its first release.
  const releaseRoot = target.status === "ok" ? target.releaseRoot : previousRelease!;
  const afterSha = target.status === "ok" ? target.candidateSha : beforeSha;
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
    return result("error", "git-release-smoke-failed");
  }
  await prepareGitMutation({
    runCommand,
    root: gitRoot,
    revision: afterSha,
    timeoutMs,
    beforeGitMutation: opts.beforeGitMutation,
  });
  let publication: Awaited<ReturnType<typeof publishGitRelease>> | undefined;
  if (target.status === "ok") {
    publication = await publishGitRelease({
      prefix,
      releaseRoot,
      trial: true,
      pending: opts.deferReleaseActivation,
    });
  }
  const collected = await collectGitReleases({
    prefix,
    keep: [releaseRoot, ...(previousRelease ? [previousRelease] : [])],
    prune: () =>
      runCommand(["git", "-C", gitRoot, "worktree", "prune"], { cwd: gitRoot, timeoutMs }),
  }).catch((error: unknown) => ({ removed: [], warnings: [String(error)] }));
  if (collected.warnings.length > 0) {
    steps.push({
      name: "git-release-collect",
      command: "collect releases",
      cwd: prefix,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message: collected.warnings.join(" ") },
    });
  }
  const afterBuildId = await readBuiltGatewayBuildId(releaseRoot);
  return {
    ...result("ok"),
    // The new release's own verdict; the previous runtime's belongs to failure recovery only.
    recovery: await verifyGitUpdateRecovery({ root: releaseRoot, sha: afterSha }),
    root: slot,
    ...(converting && publication?.rollback ? { gitReleaseConversion: publication.rollback } : {}),
    gitRuntime: await readGitRuntimeArtifactIdentity(releaseRoot),
    after: {
      sha: afterSha,
      version,
      ...(afterBuildId ? { buildId: afterBuildId } : {}),
      ...(opts.devTarget?.mode === "tracked" ? { upstreamRef: opts.devTarget.upstreamRef } : {}),
    },
  };
}
