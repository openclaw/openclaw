// Shares fresh Dev target facts between background and interactive discovery.
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { VERSION } from "../version.js";
import { DEV_BRANCH } from "./update-channels.js";
import type { UpdateCheckResult } from "./update-check.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";

export async function resolveDevGitUpdate(status: UpdateCheckResult, signal: AbortSignal) {
  signal.throwIfAborted();
  const git = status.git;
  if (
    status.installKind !== "git" ||
    git?.fetchOk !== true ||
    typeof git.behind !== "number" ||
    git.behind <= 0 ||
    !git.sha ||
    !git.upstream ||
    !git.upstreamSha
  ) {
    return null;
  }
  const currentSha = git.sha;
  const upstreamRef = git.upstream;
  const upstreamSha = git.upstreamSha;
  const commitsBehind = git.behind;
  const commits = await resolveDevGitCommits({ root: git.root, currentSha, upstreamSha, signal });
  signal.throwIfAborted();
  const target: Extract<UpdateScheduleState["target"], { kind: "git" }> = {
    kind: "git",
    upstreamRef,
    upstreamSha,
    commitsBehind,
  };
  const available: UpdateAvailable = {
    currentVersion: VERSION,
    latestVersion: VERSION,
    channel: "dev",
    currentSha,
    upstreamRef,
    upstreamSha,
    ...(git.repositoryUrl ? { repositoryUrl: git.repositoryUrl } : {}),
    commitsBehind,
    commits,
  };
  return { git, target, available };
}

export function canRunDevGitCampaign(git: NonNullable<UpdateCheckResult["git"]>): boolean {
  const tracked =
    (git.branch === DEV_BRANCH || git.branch === "HEAD") && git.upstreamSource === "tracking";
  const receipt = git.branch === "HEAD" && git.upstreamSource === "receipt";
  return (tracked || receipt) && git.ahead === 0;
}
