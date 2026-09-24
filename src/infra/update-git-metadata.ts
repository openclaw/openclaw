import hostedGitInfo from "hosted-git-info";
import { executeGitCommand } from "./git-exec.js";

export type GitTrackingTarget = {
  revision: string;
  display: string;
  fetch: "prune" | { remote: string; mergeRef: string };
};

const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

export async function resolveGitRepositoryMetadata(
  readGit: (...args: string[]) => Promise<string | null>,
  tracking: GitTrackingTarget | null,
  branch: string | null,
): Promise<{ repositoryUrl?: string }> {
  const remote = tracking
    ? tracking.fetch === "prune"
      ? await readGit("config", "--get", `branch.${branch}.remote`)
      : tracking.fetch.remote
    : null;
  const remoteUrl =
    remote && remote !== "." ? await readGit("remote", "get-url", "--", remote) : null;
  // Git accepts relative local remotes that hosted-git-info treats as npm shorthands.
  const repository =
    remoteUrl && /^(?:(?:https?|ssh|git):\/\/|git@github\.com:)/u.test(remoteUrl)
      ? hostedGitInfo.fromUrl(remoteUrl)
      : undefined;
  // Never expose remote credentials or local paths in update announcements.
  const repositoryUrl =
    repository?.type === "github" ? repository.browse({ noCommittish: true }) : undefined;
  return repositoryUrl ? { repositoryUrl } : {};
}

export async function resolveDevGitCommits(params: {
  root: string;
  currentSha: string;
  upstreamSha: string;
  signal: AbortSignal;
}): Promise<Array<{ sha: string; subject: string }>> {
  const result = await executeGitCommand(
    params.root,
    [
      "log",
      "--format=%h%x09%s",
      `--max-count=${DEV_COMMIT_LIMIT}`,
      `${params.currentSha}..${params.upstreamSha}`,
    ],
    {
      timeoutMs: 2500,
      signal: params.signal,
      killProcessTree: true,
      maxOutputBytes: { stdout: DEV_COMMIT_LOG_MAX_OUTPUT_BYTES, stderr: 1024 },
    },
  ).catch(() => null);
  if (!result || result.code !== 0 || result.termination !== "exit") {
    return [];
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      const sha = separator < 0 ? "" : line.slice(0, separator).trim();
      if (!sha) {
        return [];
      }
      return [
        {
          sha,
          subject: line
            .slice(separator + 1)
            .trim()
            .slice(0, DEV_COMMIT_SUBJECT_MAX_LENGTH),
        },
      ];
    })
    .slice(0, DEV_COMMIT_LIMIT);
}
