import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readVerifiedGitUpdateReceipt, type VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import { checkUpdateStatus, type UpdateCheckResult } from "./update-check.js";
import { updateInstallRootsMatch } from "./update-install-root.js";

export async function resolveStartupInstallStatus(fetchRemoteGit: boolean, signal: AbortSignal) {
  const [root, installReceipt] = await Promise.all([
    resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }),
    readVerifiedGitUpdateReceipt(),
  ]);
  const gitUpstreamFallback =
    installReceipt?.upstreamRef && root && updateInstallRootsMatch(root, installReceipt.root)
      ? { currentSha: installReceipt.sha, upstreamRef: installReceipt.upstreamRef }
      : undefined;
  const status = await checkUpdateStatus({
    root,
    signal,
    ...(fetchRemoteGit ? {} : { timeoutMs: 2500 }),
    fetchGit: fetchRemoteGit,
    includeRegistry: false,
    ...(fetchRemoteGit ? { useDetachedDevUpstream: true } : {}),
    ...(gitUpstreamFallback ? { gitUpstreamFallback } : {}),
  });
  signal.throwIfAborted();
  return { root, status, installReceipt };
}

type GitScheduleStatus = NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]>;

function resolveGitInstalledAtMs(
  git: NonNullable<UpdateCheckResult["git"]>,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): number | undefined {
  return installReceipt &&
    root !== null &&
    updateInstallRootsMatch(root, installReceipt.root) &&
    git.sha &&
    gitCommitPrefixesMatch(installReceipt.sha, git.sha)
    ? installReceipt.installedAtMs
    : undefined;
}

function resolveGitScheduleStatus(
  update: UpdateCheckResult,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): GitScheduleStatus | undefined {
  if (update.installKind !== "git") {
    return undefined;
  }
  const git = update.git;
  const installedAtMs = git ? resolveGitInstalledAtMs(git, installReceipt, root) : undefined;
  const metadata = git
    ? {
        ...(git.sha ? { currentSha: git.sha } : {}),
        ...(typeof git.commitAtMs === "number" ? { commitAtMs: git.commitAtMs } : {}),
        ...(installedAtMs === undefined ? {} : { installedAtMs }),
      }
    : {};
  if (!git || git.error || !git.sha) {
    return { ...metadata, status: "unavailable", reason: "git-unavailable" };
  }
  if (git.fetchOk !== true) {
    return { ...metadata, status: "unavailable", reason: "fetch-failed" };
  }
  if (!git.upstream) {
    return { ...metadata, status: "unavailable", reason: "no-upstream" };
  }
  if (!git.upstreamSha) {
    return { ...metadata, status: "unavailable", reason: "no-upstream-sha" };
  }
  if (git.ahead === null || git.behind === null) {
    return { ...metadata, status: "unavailable", reason: "comparison-failed" };
  }
  const comparison = {
    ...metadata,
    upstreamSha: git.upstreamSha,
    ...(git.repositoryUrl ? { repositoryUrl: git.repositoryUrl } : {}),
  };
  if (git.ahead > 0 && git.behind > 0) {
    return {
      ...comparison,
      status: "diverged",
      commitsAhead: git.ahead,
      commitsBehind: git.behind,
    };
  }
  if (git.behind > 0) {
    return { ...comparison, status: "behind", commitsBehind: git.behind };
  }
  if (git.ahead > 0) {
    return { ...comparison, status: "ahead", commitsAhead: git.ahead };
  }
  return { ...comparison, status: "current" };
}

export function withUpdateInstallStatus(
  schedule: UpdateScheduleState,
  update: UpdateCheckResult,
  includeGitStatus: boolean,
  installReceipt: VerifiedGitUpdateReceipt | null,
  root: string | null,
): UpdateScheduleState {
  const git = includeGitStatus ? resolveGitScheduleStatus(update, installReceipt, root) : undefined;
  return {
    ...schedule,
    install: {
      kind: update.installKind,
      ...(git ? { git } : {}),
    },
  };
}
