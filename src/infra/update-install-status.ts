import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { VERSION } from "../version.js";
import { sleepWithAbort } from "./backoff.js";
import { formatErrorMessage } from "./errors.js";
import { gitCommitPrefixesMatch } from "./git-commit.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { readVerifiedGitUpdateReceipt, type VerifiedGitUpdateReceipt } from "./restart-sentinel.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "./update-channels.js";
import { checkUpdateStatus, type UpdateCheckResult } from "./update-check.js";
import { updateInstallRootsMatch } from "./update-install-root.js";
import type { StartupInstallStatus } from "./update-install-status.types.js";

export async function resolveStartupInstallStatus(
  fetchRemoteGit: boolean,
  signal: AbortSignal,
): Promise<StartupInstallStatus> {
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
  const timeoutMs = resolveGatewayStartupTiming().deadlineMs;
  const options = {
    root,
    signal,
    ...(fetchRemoteGit ? {} : { timeoutMs }),
    fetchGit: fetchRemoteGit,
    includeRegistry: false,
    ...(fetchRemoteGit ? { useDetachedDevUpstream: true } : {}),
    ...(gitUpstreamFallback ? { gitUpstreamFallback } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    let status: UpdateCheckResult | undefined;
    let timedOut = false;
    let failure: unknown;
    try {
      status = await checkUpdateStatus({
        ...options,
        ...(!fetchRemoteGit
          ? {
              onGitProbeTimeout: () => {
                timedOut = true;
              },
            }
          : {}),
      });
      signal.throwIfAborted();
      if (!timedOut) {
        return { root, status, installReceipt };
      }
    } catch (error) {
      if (!timedOut) {
        throw error;
      }
      failure = error;
    }
    signal.throwIfAborted();
    if (attempt === 0) {
      await sleepWithAbort(1_000, signal);
      continue;
    }
    const message = failure
      ? formatErrorMessage(failure)
      : `Git update facts unavailable after two ${timeoutMs / 1000}s checks`;
    status = {
      ...(status ?? { root, installKind: "unknown", packageManager: "unknown" }),
      ...(status?.git ? { git: { ...status.git, error: message } } : {}),
      error: { status: "failed", message, timeoutMs },
    };
    return { root, status, installReceipt };
  }
}

export async function prepareStartupUpdateInstall(
  initialize: () => Promise<StartupInstallStatus>,
  configChannel: UpdateChannel | null,
  signal: AbortSignal,
) {
  let installStatus = await initialize();
  signal.throwIfAborted();
  if (installStatus.status.error) {
    throw new Error(installStatus.status.error.message);
  }
  const resolveChannel = () =>
    resolveEffectiveUpdateChannel({
      configChannel,
      currentVersion: VERSION,
      ...installStatus.status,
    }).channel;
  let channel = resolveChannel();
  if (channel === "dev" && installStatus.status.installKind === "git") {
    installStatus = await resolveStartupInstallStatus(true, signal);
    signal.throwIfAborted();
    channel = resolveChannel();
  }
  const { status, installReceipt, root } = installStatus;
  const readOnlySchedule =
    status.installKind === "host" || status.installKind === "immutable"
      ? withUpdateInstallStatus(
          { channel, autoEnabled: false },
          status,
          false,
          installReceipt,
          root,
        )
      : undefined;
  return { installStatus, channel, readOnlySchedule };
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
  if (update.error?.timeoutMs) {
    return { status: "unavailable", reason: "git-unavailable" };
  }
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
  if (!git.upstream) {
    return { ...metadata, status: "unavailable", reason: "no-upstream" };
  }
  if (git.fetchOk !== true) {
    return { ...metadata, status: "unavailable", reason: "fetch-failed" };
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
  if (update.installKind === "host") {
    // Host ownership is not a package/Git update target in the Gateway protocol.
    const { install: _install, target: _target, campaign: _campaign, ...rest } = schedule;
    return { ...rest, autoEnabled: false };
  }
  if (update.installKind === "immutable") {
    const { target: _target, campaign: _campaign, ...rest } = schedule;
    return {
      ...rest,
      autoEnabled: false,
      install: { kind: "immutable", ...(update.immutable ? { immutable: update.immutable } : {}) },
    };
  }
  const git = includeGitStatus ? resolveGitScheduleStatus(update, installReceipt, root) : undefined;
  return {
    ...schedule,
    install: {
      kind: update.installKind,
      ...(git ? { git } : {}),
    },
  };
}
