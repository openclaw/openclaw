import path from "node:path";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { hasErrnoCode } from "./errno.js";
import { readPackageManagerSpec } from "./package-json.js";
import { DEV_BRANCH, resolveDevUpstreamRefs } from "./update-channels.js";
import { resolveDevUpdateTargetRevision, type DevUpdateTarget } from "./update-dev-target.js";
import {
  parsePnpmPackageManagerVersion,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { cleanupGitPreflight } from "./update-runner-git-cleanup.js";
import {
  buildDevTargetRefResolutionCandidates,
  classifyPreflightFailure,
  createPreflightRoot,
  gitCleanCheckArgs,
  prepareCandidateCommandEnv,
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  resolveTagFetchRef,
  resetPreflightCandidateWorktree,
  type StepFactory,
  shouldInstallWithoutScriptsOnWindows,
  shouldRunDevPreflightLint,
} from "./update-runner-git-commands.js";
import { prepareGitCandidateNodeRuntime } from "./update-runner-git-node-preflight.js";
import { runClassifiedGitStep, runGitCleanCheckStep } from "./update-runner-git-steps.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const PREFLIGHT_MAX_COMMITS = 10;
const PREFLIGHT_WORKTREE_DIRNAME = process.platform === "win32" ? "wt" : "worktree";

type GitCandidatePreflightResult =
  | {
      status: "ok";
      candidateSha: string;
      selectedDevUpstream: string | null;
      localDevBranchExists: boolean | null;
    }
  | { status: "error" | "skipped"; reason: NonNullable<UpdateRunResult["reason"]> };

async function resolveExplicitTarget(params: {
  devTargetRef: string;
  refreshedRemotes: readonly string[];
  gitRoot: string;
  step: StepFactory;
  workStep: StepFactory;
}): Promise<string | null> {
  const warnings: string[] = [];
  for (const candidate of buildDevTargetRefResolutionCandidates(params.devTargetRef)) {
    if (
      candidate.startsWith("refs/remotes/") &&
      !params.refreshedRemotes.some((remote) => candidate.startsWith(`refs/remotes/${remote}/`))
    ) {
      continue;
    }
    const tagFetchRef = resolveTagFetchRef(candidate);
    if (tagFetchRef) {
      const remoteStep = await runStep(
        params.step("git-remote", ["git", "-C", params.gitRoot, "remote"], params.gitRoot),
      );
      if (isFailedUpdateStep(remoteStep)) {
        return null;
      }
      const remotes = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n"));
      let fetchedTag = false;
      for (const remote of remotes) {
        const options = params.workStep(
          "git-fetch-target-tag",
          ["git", "-C", params.gitRoot, "fetch", remote, `+${tagFetchRef}:${tagFetchRef}`],
          params.gitRoot,
        );
        const fetchOutcome = await runClassifiedGitStep(options, (fetchStep) => {
          const interrupted =
            fetchStep.termination === "signal" ||
            fetchStep.exitCode === 130 ||
            fetchStep.exitCode === 143;
          const fetchedSuccessfully = fetchStep.exitCode === 0 && !isFailedUpdateStep(fetchStep);
          if (!fetchedSuccessfully && !interrupted) {
            fetchStep.advisory = {
              kind: "recoverable-maintenance",
              message: `Could not fetch the requested tag from ${remote}; trying another remote. ${fetchStep.stderrTail ?? ""}`,
            };
            warnings.push(fetchStep.advisory.message);
          }
          if (warnings.length > 0) {
            fetchStep.warnings = [...warnings];
          }
          return { interrupted, fetchedSuccessfully };
        });
        if (fetchOutcome.interrupted) {
          return null;
        }
        if (fetchOutcome.fetchedSuccessfully) {
          fetchedTag = true;
          break;
        }
      }
      if (remotes.length > 0 && !fetchedTag) {
        continue;
      }
    }
    const shaStep = await runStep(
      params.step(
        "git-resolve-target",
        ["git", "-C", params.gitRoot, "rev-parse", candidate],
        params.gitRoot,
      ),
    );
    const sha = shaStep.stdoutTail?.trim();
    if (!isFailedUpdateStep(shaStep) && sha) {
      return sha;
    }
  }
  return null;
}

async function resolveUpstreamCandidates(params: {
  gitRoot: string;
  needsCheckoutMain: boolean;
  refreshedRemotes: readonly string[];
  step: StepFactory;
}): Promise<
  | {
      status: "ok";
      sha: string;
      candidates: string[];
      selectedDevUpstream: string | null;
      localDevBranchExists: boolean | null;
    }
  | { status: "error" | "skipped"; reason: NonNullable<UpdateRunResult["reason"]> }
> {
  let localDevBranchExists: boolean | null = null;
  let remoteBranchRefs: string[] = [];
  if (params.needsCheckoutMain) {
    const localMainStep = await runStep(
      params.step(
        "git-show-branch",
        ["git", "-C", params.gitRoot, "show-ref", "--verify", `refs/heads/${DEV_BRANCH}`],
        params.gitRoot,
      ),
    );
    localDevBranchExists = localMainStep.exitCode === 0;
  }
  if (params.needsCheckoutMain && localDevBranchExists === false) {
    remoteBranchRefs = params.refreshedRemotes.map(
      (remote) => `refs/remotes/${remote}/${DEV_BRANCH}`,
    );
  }
  const upstreamRefs = resolveDevUpstreamRefs(params.needsCheckoutMain, remoteBranchRefs);
  let upstreamSha: string | null = null;
  let selectedDevUpstream: string | null = null;
  let sawResolvableUpstreamRef = false;
  for (const upstreamRef of upstreamRefs) {
    let resolvedUpstreamRef = upstreamRef;
    if (upstreamRef.endsWith("@{upstream}")) {
      const upstreamStep = await runStep(
        params.step(
          "upstream-check",
          ["git", "-C", params.gitRoot, "rev-parse", "--symbolic-full-name", upstreamRef],
          params.gitRoot,
        ),
      );
      if (isFailedUpdateStep(upstreamStep)) {
        continue;
      }
      sawResolvableUpstreamRef = true;
      resolvedUpstreamRef = upstreamStep.stdoutTail?.trim() ?? upstreamRef;
    }
    const shaStep = await runStep(
      params.step(
        "git-resolve-upstream",
        ["git", "-C", params.gitRoot, "rev-parse", upstreamRef],
        params.gitRoot,
      ),
    );
    const sha = shaStep.stdoutTail?.trim();
    if (!isFailedUpdateStep(shaStep) && sha) {
      upstreamSha = sha;
      selectedDevUpstream = /^refs\/remotes\/(.+)$/u.exec(resolvedUpstreamRef)?.[1] ?? null;
      break;
    }
    if (!isFailedUpdateStep(shaStep)) {
      sawResolvableUpstreamRef = true;
    }
  }
  if (!upstreamSha) {
    return sawResolvableUpstreamRef
      ? { status: "error", reason: "no-upstream-sha" }
      : { status: "skipped", reason: "no-upstream" };
  }
  const revListStep = await runStep(
    params.step(
      "git-rev-list",
      [
        "git",
        "-C",
        params.gitRoot,
        "rev-list",
        `--max-count=${PREFLIGHT_MAX_COMMITS}`,
        upstreamSha,
      ],
      params.gitRoot,
    ),
  );
  if (isFailedUpdateStep(revListStep)) {
    return { status: "error", reason: "preflight-revlist-failed" };
  }
  const candidates = normalizeStringEntries((revListStep.stdoutTail ?? "").split("\n"));
  if (candidates.length === 0) {
    return { status: "error", reason: "preflight-no-candidates" };
  }
  return {
    status: "ok",
    sha: upstreamSha,
    candidates,
    selectedDevUpstream,
    localDevBranchExists,
  };
}

type PreflightCandidateResult =
  | { status: "ok"; candidateSha: string }
  | { status: "manager-unavailable"; reason: string }
  | { status: "failed" | "insufficient-space" | "node-runtime-incompatible" };

async function testPreflightCandidate(
  params: Parameters<typeof runGitCandidatePreflight>[0] & {
    worktreeDir: string;
    preflightRoot: string;
    sha: string;
    rebaseFrom?: string;
    runLint: boolean;
  },
): Promise<PreflightCandidateResult> {
  if (!(await resetPreflightCandidateWorktree(params.worktreeDir, params.workStep))) {
    return { status: "failed" };
  }
  const runCandidateCheck = async (
    name: string,
    argv: string[],
    env?: NodeJS.ProcessEnv,
    factory = params.workStep,
  ) => {
    const check = factory(`preflight-${name}`, argv, params.worktreeDir, env);
    const result = await runStep(check);
    return isFailedUpdateStep(result) ? result : null;
  };
  const checkout = await runCandidateCheck("checkout", [
    "git",
    "-C",
    params.worktreeDir,
    "checkout",
    "--detach",
    params.sha,
  ]);
  if (checkout) {
    return { status: classifyPreflightFailure(checkout) };
  }
  if (params.rebaseFrom) {
    const source = await runCandidateCheck("local-checkout", [
      "git",
      "-C",
      params.worktreeDir,
      "checkout",
      "--detach",
      params.rebaseFrom,
    ]);
    const rebase =
      source ??
      (await runCandidateCheck("rebase", [
        "git",
        "-C",
        params.worktreeDir,
        "rebase",
        ...(params.referenceSource ? ["--rebase-merges"] : []),
        params.sha,
      ]));
    if (rebase) {
      await runCandidateCheck(
        "rebase-abort",
        ["git", "-C", params.worktreeDir, "rebase", "--abort"],
        undefined,
        params.step,
      );
      return { status: classifyPreflightFailure(rebase) };
    }
  }
  const candidateHead = await params.runCommand(
    ["git", "-C", params.worktreeDir, "rev-parse", "HEAD"],
    {
      cwd: params.worktreeDir,
      timeoutMs: params.timeoutMs,
    },
  );
  if (candidateHead.code !== 0 || !candidateHead.stdout.trim()) {
    return { status: "failed" };
  }
  const candidateSha = candidateHead.stdout.trim();
  // A local rebase can change package metadata from the fetched base revision.
  await params.beforeCandidate(candidateSha);
  await params.referenceSource?.copyBuildInputs(params.worktreeDir);
  if (
    params.frozenLockfile &&
    !parsePnpmPackageManagerVersion(await readPackageManagerSpec(params.worktreeDir))
  ) {
    return { status: "manager-unavailable", reason: "immutable-pnpm-pin-required" };
  }
  const nodeRuntime = await prepareGitCandidateNodeRuntime(
    params.worktreeDir,
    params.defaultCommandEnv,
  );
  if (nodeRuntime.step) {
    params.steps.push(nodeRuntime.step);
    return { status: "node-runtime-incompatible" };
  }
  if (params.referenceSource) {
    const version = parsePnpmPackageManagerVersion(
      await readPackageManagerSpec(params.worktreeDir),
    );
    const probe = await runStep({
      ...params.step(
        "preflight-package-manager",
        ["pnpm", "--version"],
        params.worktreeDir,
        nodeRuntime.env,
      ),
      runCommand: async (argv, options) => {
        const result = version
          ? await params.runCommand(argv, options)
          : { code: 1, stdout: "", stderr: "" };
        return version && result.stdout.trim() === version
          ? result
          : {
              ...result,
              code: 1,
              stderr:
                "Reference source updates require an exact pnpm packageManager pin supported by the scoped Corepack shim. Repair Corepack or the candidate pin, then retry.",
            };
      },
    });
    if (isFailedUpdateStep(probe)) {
      return { status: "manager-unavailable", reason: "reference-source-pnpm-unavailable" };
    }
  }
  const manager: Awaited<ReturnType<typeof resolveUpdateBuildManager>> = params.referenceSource
    ? { kind: "resolved", manager: "pnpm", fallback: false }
    : await resolveUpdateBuildManager(
        params.runCommand,
        params.worktreeDir,
        params.timeoutMs,
        nodeRuntime.env,
        { timeoutMs: params.workTimeoutMs },
      );
  if (manager.kind === "missing-required") {
    params.steps.push({
      name: "preflight-package-manager",
      command: `resolve ${manager.preferred} package manager`,
      cwd: params.worktreeDir,
      durationMs: 0,
      exitCode: 1,
      stderrTail: manager.reason,
    });
    return { status: "manager-unavailable", reason: manager.reason };
  }
  try {
    const preferIgnoreScripts =
      !params.referenceSource && shouldInstallWithoutScriptsOnWindows(manager.manager);
    const installArgv = [
      manager.manager,
      "install",
      ...(preferIgnoreScripts
        ? ["--ignore-scripts"]
        : manager.fallback && manager.manager === "npm"
          ? ["--no-package-lock", "--legacy-peer-deps"]
          : []),
    ];
    const installName = preferIgnoreScripts ? "deps-install-ignore-scripts" : "deps-install";
    if (params.referenceSource || params.frozenLockfile) {
      installArgv.push("--frozen-lockfile");
    }
    const candidateCommand = await prepareCandidateCommandEnv(
      manager.manager,
      manager.env ?? nodeRuntime.env,
      params.worktreeDir,
      params.runCommand,
      params.timeoutMs,
    );
    const scriptArgs = (script: string) =>
      manager.manager === "pnpm" ? ["pnpm", script] : [manager.manager, "run", script];
    const buildEnv = resolveBuildEnv(
      candidateCommand.env,
      path.join(params.artifactRoot, ".artifacts", "build-all-cache"),
    );
    buildEnv.sourceRuntimePrepared = params.sourceRuntimePrepared?.toString();
    let failure =
      (await runCandidateCheck(installName, installArgv, candidateCommand.env)) ??
      (await runCandidateCheck("build", scriptArgs("build"), buildEnv));
    if (
      !failure &&
      (await resolveControlUiAssetHealth({ root: params.worktreeDir })).kind !== "ready"
    ) {
      failure = await runCandidateCheck("ui-build", scriptArgs("ui:build"), candidateCommand.env);
    }
    if (
      !failure &&
      (await resolveControlUiAssetHealth({ root: params.worktreeDir })).kind !== "ready"
    ) {
      params.steps.push({
        name: "preflight-ui-assets-verify",
        command: "verify startup assets",
        cwd: params.worktreeDir,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "Update Control UI startup assets are missing or incomplete",
      });
      return { status: "failed" };
    }
    if (!failure && params.runLint) {
      failure = await runCandidateCheck(
        "lint",
        scriptArgs("lint"),
        resolveDevPreflightLintEnv(candidateCommand.env),
      );
    }
    if (failure) {
      return { status: classifyPreflightFailure(failure) };
    }
    // Global source exposure can run package lifecycle scripts. Validate and retain
    // the resulting candidate only after that preparation finishes.
    await params.prepareGitExposure?.(params.worktreeDir, candidateSha, candidateCommand.env);
    await candidateCommand.restoreWorkspace?.();
    await params.validateCandidate(params.worktreeDir);
    // Activation checks out candidateSha and promotes only generated runtime paths.
    // Check after repair so validated source edits cannot disappear at activation.
    const { result: cleanCheck } = await runGitCleanCheckStep(
      params.step(
        "preflight-update-clean-check",
        params.referenceSource
          ? ["git", "-C", params.worktreeDir, "status", "--porcelain", "--untracked-files=no"]
          : gitCleanCheckArgs(params.worktreeDir),
        params.worktreeDir,
      ),
    );
    if (isFailedUpdateStep(cleanCheck)) {
      return { status: "failed" };
    }
    const sourceCheck = await runCandidateCheck(
      "update-source-check",
      ["git", "-C", params.worktreeDir, "diff", "--quiet", candidateSha, "--"],
      undefined,
      params.step,
    );
    if (sourceCheck) {
      sourceCheck.stderrTail =
        "Update source differs from the selected commit. Repair the source revision before retrying the update.";
      return { status: "failed" };
    }
    await params.prepareCandidate?.(params.worktreeDir, params.preflightRoot);
    return { status: "ok", candidateSha };
  } finally {
    await manager.cleanup?.();
  }
}

export async function runGitCandidatePreflight(params: {
  gitRoot: string;
  artifactRoot: string;
  devTarget?: DevUpdateTarget;
  refreshedRemotes: readonly string[];
  targetRevision?: string;
  beforeSha?: string | null;
  referenceSource?: {
    branch: string;
    copyBuildInputs: (candidateRoot: string) => Promise<void>;
  };
  beforeRuntimeVerified: boolean;
  sourceRuntimePrepared?: boolean;
  /** Immutable releases must build exactly the candidate's recorded dependency graph. */
  frozenLockfile?: boolean;
  beforeGitStaging?: UpdateRunnerOptions["beforeGitStaging"];
  validateCandidate: UpdateRunnerOptions["validateCandidate"];
  prepareGitExposure?: UpdateRunnerOptions["prepareGitExposure"];
  prepareCandidate?: (root: string, cleanupRoot: string) => Promise<void>;
  retainCleanup?: (cleanup: () => Promise<boolean>) => boolean;
  needsCheckoutMain: boolean;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
  workStep: StepFactory;
  workTimeoutMs?: number;
  beforeCandidate: (revision: string) => Promise<void>;
}): Promise<GitCandidatePreflightResult> {
  if (params.referenceSource) {
    if (!params.targetRevision || !params.beforeSha) {
      throw new Error("Reference source preparation requires the original HEAD and pinned target.");
    }
    if (params.referenceSource.branch === DEV_BRANCH) {
      const ancestry = await runStep(
        params.step(
          "reference-source-fast-forward",
          [
            "git",
            "-C",
            params.gitRoot,
            "merge-base",
            "--is-ancestor",
            params.beforeSha,
            params.targetRevision,
          ],
          params.gitRoot,
        ),
      );
      if (isFailedUpdateStep(ancestry)) {
        return { status: "error", reason: "reference-source-not-fast-forward" };
      }
    }
  }
  const devTargetRef = params.devTarget
    ? normalizeNullableString(resolveDevUpdateTargetRevision(params.devTarget))
    : null;
  let preflightBaseSha: string;
  let candidates: string[];
  let selectedDevUpstream: string | null = null;
  let localDevBranchExists: boolean | null = null;
  if (params.targetRevision) {
    const result = await params.runCommand(
      ["git", "-C", params.gitRoot, "rev-parse", `${params.targetRevision}^{commit}`],
      {
        cwd: params.gitRoot,
        timeoutMs: params.timeoutMs,
      },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return { status: "error", reason: "no-target-sha" };
    }
    preflightBaseSha = result.stdout.trim();
    candidates = [preflightBaseSha];
  } else if (devTargetRef) {
    const targetSha = await resolveExplicitTarget({ ...params, devTargetRef });
    if (!targetSha) {
      return { status: "error", reason: "no-target-sha" };
    }
    preflightBaseSha = targetSha;
    candidates = [targetSha];
    if (params.devTarget?.mode === "tracked") {
      const ancestryStep = await runStep(
        params.step(
          "tracked-target-ancestry",
          [
            "git",
            "-C",
            params.gitRoot,
            "merge-base",
            "--is-ancestor",
            targetSha,
            `${params.devTarget.upstreamRef}^{commit}`,
          ],
          params.gitRoot,
        ),
      );
      if (isFailedUpdateStep(ancestryStep)) {
        return { status: "error", reason: "tracked-upstream-invalid" };
      }
    }
  } else {
    const upstream = await resolveUpstreamCandidates(params);
    if (upstream.status !== "ok") {
      return upstream;
    }
    preflightBaseSha = upstream.sha;
    candidates = upstream.candidates;
    selectedDevUpstream = upstream.selectedDevUpstream;
    localDevBranchExists = upstream.localDevBranchExists;
  }

  // Reference builds must consume operator inputs even when their Git HEAD is current.
  // Source identity alone cannot prove the installed build is complete.
  const canSkipActivation =
    !params.referenceSource && !params.prepareGitExposure && params.beforeRuntimeVerified;
  if (canSkipActivation && preflightBaseSha === params.beforeSha) {
    return { status: "skipped", reason: "already-current" };
  }
  if (params.beforeGitStaging) {
    const admission = await params.beforeGitStaging();
    params.steps.push(admission.step);
    if (isFailedUpdateStep(admission.step)) {
      return { status: "error", reason: admission.failureReason };
    }
  }
  const rebaseFrom = params.referenceSource
    ? params.referenceSource.branch === DEV_BRANCH
      ? undefined
      : (params.beforeSha ?? undefined)
    : !params.targetRevision && !params.devTarget && localDevBranchExists !== false
      ? params.needsCheckoutMain
        ? DEV_BRANCH
        : (params.beforeSha ?? undefined)
      : undefined;

  // Worktree checkout can execute filters, and subsequent checks run target code.
  // Admit its metadata before either operation, then admit each distinct fallback.
  await params.beforeCandidate(preflightBaseSha);
  let preflightRoot: string;
  try {
    preflightRoot = await createPreflightRoot(params.artifactRoot);
  } catch (error) {
    return {
      status: "error",
      reason: hasErrnoCode(error, "ENOSPC")
        ? "preflight-insufficient-space"
        : "preflight-worktree-failed",
    };
  }
  const worktreeDir = path.join(preflightRoot, PREFLIGHT_WORKTREE_DIRNAME);
  let tested: PreflightCandidateResult | undefined;
  let cleanupUncertain = false;
  try {
    const worktreeStep = await runStep(
      params.workStep(
        "preflight-worktree",
        ["git", "-C", params.gitRoot, "worktree", "add", "--detach", worktreeDir, preflightBaseSha],
        params.gitRoot,
      ),
    );
    if (isFailedUpdateStep(worktreeStep)) {
      return {
        status: "error",
        reason:
          classifyPreflightFailure(worktreeStep) === "insufficient-space"
            ? "preflight-insufficient-space"
            : "preflight-worktree-failed",
      };
    }
    for (const sha of candidates) {
      if (canSkipActivation && sha === params.beforeSha) {
        return { status: "skipped", reason: "already-current" };
      }
      if (sha !== preflightBaseSha) {
        await params.beforeCandidate(sha);
      }
      const candidate = await testPreflightCandidate({
        ...params,
        worktreeDir,
        preflightRoot,
        sha,
        rebaseFrom,
        runLint: !params.targetRevision && shouldRunDevPreflightLint(),
      });
      // Node requirements and package managers can differ across older revisions.
      if (candidate.status === "ok" || candidate.status === "insufficient-space") {
        tested = candidate;
        break;
      }
      // Preserve build failures over manager failures, and manager failures over
      // runtime-only rejection when a compatible candidate was attempted.
      const runtimeMismatch = candidate.status === "node-runtime-incompatible";
      if (tested?.status !== "failed" && (!runtimeMismatch || !tested)) {
        tested = candidate;
      }
    }
  } catch (error) {
    cleanupUncertain = hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!cleanupUncertain) {
      const cleanup = () => cleanupGitPreflight(params, worktreeDir, preflightRoot);
      if (tested?.status !== "ok" || !params.retainCleanup?.(cleanup)) {
        await cleanup();
      }
    }
  }
  if (tested?.status !== "ok") {
    return {
      status: "error",
      reason:
        tested?.status === "insufficient-space"
          ? "preflight-insufficient-space"
          : tested?.status === "manager-unavailable"
            ? tested.reason
            : tested?.status === "node-runtime-incompatible"
              ? "preflight-node-runtime-incompatible"
              : "preflight-no-good-commit",
    };
  }
  return {
    status: "ok",
    candidateSha: tested.candidateSha,
    selectedDevUpstream,
    localDevBranchExists,
  };
}
