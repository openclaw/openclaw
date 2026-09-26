import hostedGitInfo from "hosted-git-info";
import { executeGitCommand } from "./git-exec.js";

export type GitFetchTarget = { remote: string; mergeRef: string };

const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

/** Select source authority before requiring its local tracking ref to exist. */
export async function readGitBranchFetchTarget(
  readGit: (...args: string[]) => Promise<string | null>,
  branch: string,
): Promise<GitFetchTarget | null> {
  const [remote, mergeRefs] = await Promise.all([
    readGit("config", "--get", `branch.${branch}.remote`),
    readGit("config", "--get-all", `branch.${branch}.merge`),
  ]);
  const mergeRef = mergeRefs?.split("\n")[0];
  if (remote && mergeRef) {
    return { remote, mergeRef };
  }
  return null;
}

function matchRefspec(pattern: string, ref: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) {
    return pattern === ref ? "" : undefined;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return ref.startsWith(prefix) &&
    ref.endsWith(suffix) &&
    ref.length >= prefix.length + suffix.length
    ? ref.slice(prefix.length, ref.length - suffix.length)
    : undefined;
}

/** Receipts retain only a destination; require one configured source before fetching it. */
export async function readGitReceiptFetchTarget(
  readGit: (...args: string[]) => Promise<string | null>,
  display: string,
  fetchRemote: boolean,
): Promise<(GitFetchTarget & { revision: string }) | null> {
  const resolved = await readGit(
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    "--end-of-options",
    display,
  );
  // Published receipts retain Git display names. Missing cache refs use only
  // gitrevisions' documented namespaces, validated without requiring an object.
  const revisions = resolved
    ? [resolved]
    : (
        await Promise.all(
          (display.startsWith("refs/")
            ? [display]
            : [
                `refs/${display}`,
                `refs/tags/${display}`,
                `refs/heads/${display}`,
                `refs/remotes/${display}`,
                `refs/remotes/${display}/HEAD`,
              ]
          ).map((ref) => readGit("check-ref-format", "--normalize", ref)),
        )
      ).filter((ref): ref is string => ref !== null);
  const refspecs =
    (await readGit("config", "--get-regexp", "^remote\\..*\\.fetch$"))?.split("\n") ?? [];
  const targets = refspecs.flatMap((line) => {
    const [, remote, source, destination] =
      /^remote\.(.+)\.fetch \+?([^:]+):(.+)$/.exec(line) ?? [];
    return revisions.flatMap((revision) => {
      const matched = destination ? matchRefspec(destination, revision) : undefined;
      return remote && source && matched !== undefined
        ? [{ remote, mergeRef: source.replace("*", matched), revision }]
        : [];
    });
  });
  // Excluded aliases are not competing sources. Retain positive mappings below
  // so an excluded remote destination cannot masquerade as a local upstream.
  const eligible = targets.filter((target) => {
    const prefix = `remote.${target.remote}.fetch ^`;
    return !refspecs.some(
      (line) =>
        line.startsWith(prefix) &&
        matchRefspec(line.slice(prefix.length), target.mergeRef) !== undefined,
    );
  });
  let unique = [...new Map(eligible.map((target) => [JSON.stringify(target), target])).values()];
  if (targets.length === 0 && resolved?.startsWith("refs/heads/")) {
    return { remote: ".", mergeRef: resolved, revision: resolved };
  }
  if (!resolved && !display.startsWith("refs/") && unique.length > 1) {
    // Disambiguate missing spellings on one configured remote, never competing
    // sources for one destination or different remotes. Local probes stay offline.
    const remotes = new Set(unique.map((target) => target.remote));
    const [remote] = remotes;
    if (
      !fetchRemote ||
      !remote ||
      remotes.size !== 1 ||
      new Set(unique.map((target) => target.revision)).size !== unique.length
    ) {
      return null;
    }
    const advertised = await readGit(
      "ls-remote",
      "--refs",
      "--",
      remote,
      ...new Set(unique.map((target) => target.mergeRef)),
    );
    const refs = new Set(advertised?.split("\n").map((line) => line.split("\t")[1]));
    unique = unique.filter((target) => refs.has(target.mergeRef));
  }
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

export async function resolveGitRepositoryMetadata(
  readGit: (...args: string[]) => Promise<string | null>,
  target: GitFetchTarget | null,
): Promise<{ repositoryUrl?: string }> {
  const remote = target?.remote;
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
