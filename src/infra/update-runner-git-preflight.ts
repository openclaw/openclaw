import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { hasErrnoCode } from "./errno.js";
import { DEV_BRANCH, resolveDevUpstreamRefs } from "./update-channels.js";
import { resolveDevUpdateTargetRevision, type DevUpdateTarget } from "./update-dev-target.js";
import {
  managerInstallArgs,
  managerInstallIgnoreScriptsArgs,
  managerScriptArgs,
  resolveUpdateBuildManager,
} from "./update-package-manager.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { cleanupGitPreflight } from "./update-runner-git-cleanup.js";
import {
  gitCleanCheckArgs,
  prepareCandidateCommandEnv,
  resolveBuildEnv,
  resolveDevPreflightLintEnv,
  shouldInstallWithoutScriptsOnWindows,
  shouldRunDevPreflightLint,
} from "./update-runner-git-commands.js";
import { checkGitCandidateNodeRuntime } from "./update-runner-git-node-preflight.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

const PREFLIGHT_MAX_COMMITS = 10;
const PREFLIGHT_TEMP_PREFIX =
  process.platform === "win32" ? "ocu-pf-" : ".openclaw-update-preflight-";
const PREFLIGHT_WORKTREE_DIRNAME = process.platform === "win32" ? "wt" : "worktree";
const WINDOWS_PREFLIGHT_BASE_DIR = "ocu";

type StepFactory = (
  name: string,
  argv: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => RunStepOptions;

type GitCandidatePreflightResult =
  | {
      status: "ok";
      candidateSha: string;
      selectedDevUpstream: string | null;
      localDevBranchExists: boolean | null;
    }
  | { status: "error" | "skipped"; reason: NonNullable<UpdateRunResult["reason"]> };

function normalizeDevTargetRef(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function looksLikeFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value.trim());
}

function resolveTagFetchRef(candidate: string): string | null {
  const ref = candidate.endsWith("^{}") ? candidate.slice(0, -"^{}".length) : candidate;
  return ref.startsWith("refs/tags/") ? ref : null;
}

function buildDevTargetRefResolutionCandidates(devTargetRef: string): string[] {
  const trimmed = devTargetRef.trim();
  if (looksLikeFullCommitSha(trimmed) || trimmed.startsWith("refs/remotes/")) {
    return [trimmed];
  }
  if (trimmed.startsWith("refs/heads/")) {
    return [`refs/remotes/origin/${trimmed.slice("refs/heads/".length)}`];
  }
  if (trimmed.startsWith("origin/")) {
    return [`refs/remotes/${trimmed}`];
  }
  if (trimmed.startsWith("refs/tags/")) {
    return [`${trimmed}^{}`, trimmed];
  }
  // Plain branch names resolve from the freshly fetched remote ref.
  return [`refs/remotes/origin/${trimmed}`, `refs/tags/${trimmed}^{}`, `refs/tags/${trimmed}`];
}

function resolvePreflightWorktreeDir(preflightRoot: string) {
  return path.join(preflightRoot, PREFLIGHT_WORKTREE_DIRNAME);
}

async function createPreflightRoot(artifactRoot: string) {
  // On POSIX, ignored artifact storage keeps interrupted worktrees out of Git status.
  // Honor existing redirects like build-all-cache; only the mkdtemp child is private.
  const baseDir =
    process.platform === "win32" && path.sep === "\\"
      ? path.win32.join(process.env.SystemDrive ?? "C:", WINDOWS_PREFLIGHT_BASE_DIR)
      : path.join(await fs.realpath(artifactRoot), ".artifacts");
  await fs.mkdir(baseDir, { recursive: true });
  return fs.mkdtemp(path.join(baseDir, PREFLIGHT_TEMP_PREFIX));
}

async function resetPreflightCandidateWorktree(worktreeDir: string, step: StepFactory) {
  const resetStep = await runStep(
    step("preflight-reset", ["git", "-C", worktreeDir, "reset", "--hard"], worktreeDir),
  );
  if (isFailedUpdateStep(resetStep)) {
    return false;
  }
  const cleanStep = await runStep(
    step("preflight-clean", ["git", "-C", worktreeDir, "clean", "-fdx"], worktreeDir),
  );
  return !isFailedUpdateStep(cleanStep);
}

async function resolveExplicitTarget(params: {
  devTargetRef: string;
  refreshedRemotes: readonly string[];
  gitRoot: string;
  steps: UpdateStepResult[];
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
        const fetchStep = await runStep({
          ...options,
          progress: { ...options.progress, onStepComplete: undefined },
        });
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
        options.progress?.onStepComplete?.({
          ...fetchStep,
          index: options.stepIndex,
          total: options.totalSteps,
        });
        if (interrupted) {
          return null;
        }
        if (fetchedSuccessfully) {
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
  steps: UpdateStepResult[];
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

function classifyPreflightFailure(step: UpdateStepResult): "failed" | "insufficient-space" {
  // pnpm reports filesystem errors on stdout by default. Require the storage
  // diagnostic: ENOSPC also covers inotify limits.
  const output = stripAnsi(`${step.stdoutTail ?? ""}\n${step.stderrTail ?? ""}`);
  const nodeNoSpace =
    /^\s*(?:\[(?:ERR_PNPM_)?ENOSPC\][^\r\n]*|(?:Error:\s*)?)ENOSPC: no space left on device(?:,|$)/m.test(
      output,
    );
  // Git uses strerror without an errno token; require a complete operation diagnostic.
  const gitNoSpace =
    /^(?:fatal|error): (?:cannot|could not|unable to) [^\r\n]+: No space left on device$/m.test(
      output,
    );
  return nodeNoSpace || gitNoSpace ? "insufficient-space" : "failed";
}

async function testPreflightCandidate(params: {
  artifactRoot: string;
  worktreeDir: string;
  preflightRoot: string;
  sha: string;
  rebaseFrom?: string;
  runLint: boolean;
  beforeCandidate: (revision: string) => Promise<void>;
  validateCandidate: UpdateRunnerOptions["validateCandidate"];
  prepareGitExposure?: UpdateRunnerOptions["prepareGitExposure"];
  prepareCandidate?: (root: string, cleanupRoot: string) => Promise<void>;
  runCommand: CommandRunner;
  timeoutMs: number;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  steps: UpdateStepResult[];
  step: StepFactory;
  workStep: StepFactory;
  workTimeoutMs?: number;
}): Promise<PreflightCandidateResult> {
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
      (await runCandidateCheck("rebase", ["git", "-C", params.worktreeDir, "rebase", params.sha]));
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
  const nodeRuntimeStep = await checkGitCandidateNodeRuntime(params.worktreeDir);
  if (nodeRuntimeStep) {
    params.steps.push(nodeRuntimeStep);
    return { status: "node-runtime-incompatible" };
  }
  const manager = await resolveUpdateBuildManager(
    params.runCommand,
    params.worktreeDir,
    params.timeoutMs,
    params.defaultCommandEnv,
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
    const preferIgnoreScripts = shouldInstallWithoutScriptsOnWindows(manager.manager);
    const installArgv = preferIgnoreScripts
      ? managerInstallIgnoreScriptsArgs(manager.manager)
      : managerInstallArgs(manager.manager, {
          compatFallback: manager.fallback && manager.manager === "npm",
        });
    const installName = preferIgnoreScripts ? "deps-install-ignore-scripts" : "deps-install";
    const candidateCommand = await prepareCandidateCommandEnv(
      manager.manager,
      manager.env ?? params.defaultCommandEnv,
      params.worktreeDir,
      params.runCommand,
      params.timeoutMs,
    );
    const buildArgs = managerScriptArgs(manager.manager, "build");
    const buildEnv = resolveBuildEnv(
      candidateCommand.env,
      path.join(params.artifactRoot, ".artifacts", "build-all-cache"),
    );
    const lintArgs = managerScriptArgs(manager.manager, "lint");
    let failure =
      (await runCandidateCheck(installName, installArgv, candidateCommand.env)) ??
      (await runCandidateCheck("build", buildArgs, buildEnv));
    if (
      !failure &&
      (await resolveControlUiAssetHealth({ root: params.worktreeDir })).kind !== "ready"
    ) {
      failure = await runCandidateCheck(
        "ui-build",
        managerScriptArgs(manager.manager, "ui:build"),
        candidateCommand.env,
      );
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
        lintArgs,
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
    const cleanCheck = await runCandidateCheck(
      "update-clean-check",
      gitCleanCheckArgs(params.worktreeDir),
      undefined,
      params.step,
    );
    const status = params.steps.at(-1);
    if (cleanCheck || status?.stdoutTail?.trim()) {
      if (status) {
        status.exitCode = 1;
      }
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
  beforeGitStaging?: UpdateRunnerOptions["beforeGitStaging"];
  validateCandidate: UpdateRunnerOptions["validateCandidate"];
  prepareGitExposure?: UpdateRunnerOptions["prepareGitExposure"];
  prepareCandidate?: (root: string, cleanupRoot: string) => Promise<void>;
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
  const devTargetRef = params.devTarget
    ? normalizeDevTargetRef(resolveDevUpdateTargetRevision(params.devTarget))
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

  // A resolved no-op must not enter validation, stop the service, or rewrite its runtime.
  if (!params.prepareGitExposure && preflightBaseSha === params.beforeSha) {
    return { status: "skipped", reason: "already-current" };
  }
  if (params.beforeGitStaging) {
    const admission = await params.beforeGitStaging();
    params.steps.push(admission.step);
    if (isFailedUpdateStep(admission.step)) {
      return { status: "error", reason: admission.failureReason };
    }
  }
  const rebaseFrom =
    !params.targetRevision && !params.devTarget && localDevBranchExists !== false
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
  const worktreeDir = resolvePreflightWorktreeDir(preflightRoot);
  let tested: PreflightCandidateResult | undefined;
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
      if (!params.prepareGitExposure && sha === params.beforeSha) {
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
  } finally {
    const cleanupOptions = params.step(
      "preflight-cleanup",
      ["git", "-C", params.gitRoot, "worktree", "remove", "--force", "--force", worktreeDir],
      params.gitRoot,
    );
    await cleanupGitPreflight(
      { ...cleanupOptions, runCommand: params.runCommand },
      worktreeDir,
      preflightRoot,
    );
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
