import hostedGitInfo from "hosted-git-info";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeGitCommand } from "./git-exec.js";
import { DEV_BRANCH } from "./update-channels.js";
import { isFullGitObjectId } from "./update-dev-target.js";
import { updateInstallRootsMatch } from "./update-install-root.js";

export type GitFetchTarget = { remote: string; mergeRef: string };
export type GitUpdateSourceHint = { root: string; sha: string; upstreamRef?: string };
export type GitUpdateFetchTarget = GitFetchTarget & {
  revision?: string;
  upstreamSource: "tracking" | "receipt";
};
const updateLog = createSubsystemLogger("update");

const DEV_COMMIT_LIMIT = 5;
const DEV_COMMIT_SUBJECT_MAX_LENGTH = 120;
const DEV_COMMIT_LOG_MAX_OUTPUT_BYTES = 8 * 1024;

/** Select source authority before requiring its local tracking ref to exist. */
export async function readGitUpdateFetchTarget(
  readGit: (...args: string[]) => Promise<string | null>,
  branch: string,
  useDevDefault = false,
  legacy?: {
    root: string;
    sha: string | null;
    receipt: GitUpdateSourceHint | null;
    fetchRemote: boolean;
  },
): Promise<GitUpdateFetchTarget | null> {
  const [remote, mergeRefs] = await Promise.all([
    readGit("config", "--get", `branch.${branch}.remote`),
    readGit("config", "--get-all", `branch.${branch}.merge`),
  ]);
  const mergeRef = mergeRefs?.split("\n")[0];
  if (remote && mergeRef) {
    return { remote, mergeRef, upstreamSource: "tracking" };
  }
  const currentBranch =
    useDevDefault || legacy?.receipt?.upstreamRef
      ? await readGit("rev-parse", "--abbrev-ref", "HEAD")
      : null;
  const receipt = legacy?.receipt;
  if (currentBranch === "HEAD" && receipt?.upstreamRef) {
    const receiptSha = receipt.sha.trim().toLowerCase();
    if (
      legacy?.sha &&
      updateInstallRootsMatch(legacy.root, receipt.root) &&
      /^[0-9a-f]{7,64}$/u.test(receiptSha) &&
      (legacy.sha.toLowerCase() === receiptSha ||
        // Enumerate local object IDs: revision names and type filtering must not
        // hide an ambiguous prefix or interpret a receipt as a ref expression.
        (receiptSha.length < legacy.sha.length &&
          (await readGit("rev-parse", "--disambiguate=" + receiptSha)) ===
            legacy.sha.toLowerCase()))
    ) {
      const hint = await readGitRefFetchTarget(readGit, receipt.upstreamRef, legacy.fetchRemote);
      if (hint) {
        return { ...hint, upstreamSource: "receipt" };
      }
    }
    updateLog.warn(
      "Ignoring an unusable or stale Git update source hint; using current repository policy.",
    );
  }
  if (!useDevDefault || remote || mergeRefs) {
    return null;
  }
  const localMain = await readGit("show-ref", "--verify", "refs/heads/" + DEV_BRANCH);
  // A named checkout with an existing untracked main is intentionally unmanaged.
  if (!currentBranch || (currentBranch !== "HEAD" && localMain)) {
    return null;
  }
  let defaultRemote: string | undefined;
  if (await readGit("remote", "get-url", "--", "origin")) {
    defaultRemote = "origin";
  } else if (!localMain) {
    // Shipped updaters support creating main from a sole custom remote with cold
    // refs. Preserve that unambiguous case, never pick the first of several remotes.
    const remotes = (await readGit("remote"))?.split("\n").filter(Boolean) ?? [];
    if (remotes.length === 1) {
      defaultRemote = remotes[0];
    }
  }
  return defaultRemote
    ? { remote: defaultRemote, mergeRef: "refs/heads/" + DEV_BRANCH, upstreamSource: "tracking" }
    : null;
}

/** Apply the selected source’s fetch mapping without changing repository configuration. */
export async function resolveGitUpdateTrackingRef(
  readGit: (...args: string[]) => Promise<string | null>,
  branch: string,
  target: GitFetchTarget & { revision?: string },
): Promise<string | null> {
  if (target.revision) {
    return target.revision;
  }
  return readGit(
    "-c",
    `branch.${branch}.remote=${target.remote}`,
    "-c",
    `branch.${branch}.merge=${target.mergeRef}`,
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  );
}

// Git refs.c ref_rev_parse_rules, in fetch's find_ref_by_name_abbrev priority order.
function gitRefSpellings(ref: string): string[] {
  return [
    ref,
    "refs/" + ref,
    "refs/tags/" + ref,
    "refs/heads/" + ref,
    "refs/remotes/" + ref,
    "refs/remotes/" + ref + "/HEAD",
  ];
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

/** Resolve a saved or explicitly pinned destination through Git's configured source mappings. */
export async function readGitRefFetchTarget(
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
  // Shipped hints include missing full and abbreviated cache refs. Git validates
  // its documented namespaces; only configured fetch mappings can establish ownership.
  const spellings = display.startsWith("refs/") ? [display] : gitRefSpellings(display).slice(1);
  const revisions = resolved
    ? [resolved]
    : (
        await Promise.all(spellings.map((ref) => readGit("check-ref-format", "--normalize", ref)))
      ).filter((ref): ref is string => Boolean(ref));
  const refspecs =
    (await readGit("config", "--get-regexp", "^remote\\..*\\.fetch$"))?.split("\n") ?? [];
  const targets = refspecs.flatMap((line) => {
    const [, remote, source, destination] =
      /^remote\.(.+)\.fetch \+?([^:]*):(.+)$/.exec(line) ?? [];
    // Git get_local_ref expands exact fetch destinations; wildcard mappings
    // instead retain their literal namespace through get_expanded_map.
    const mappedDestination =
      destination && !destination.includes("*") && !destination.startsWith("refs/")
        ? /^(?:heads|tags|remotes)\//u.test(destination)
          ? "refs/" + destination
          : "refs/heads/" + destination
        : destination;
    return revisions.flatMap((revision) => {
      const matched = mappedDestination ? matchRefspec(mappedDestination, revision) : undefined;
      return remote && source !== undefined && matched !== undefined
        ? [{ remote, mergeRef: source.replace("*", () => matched), revision }]
        : [];
    });
  });
  const isExcluded = (target: GitFetchTarget, source = target.mergeRef) => {
    const prefix = "remote." + target.remote + ".fetch ^";
    return refspecs.some(
      (line) =>
        line.startsWith(prefix) && matchRefspec(line.slice(prefix.length), source) !== undefined,
    );
  };
  const eligible = targets.filter((target) => !isExcluded(target));
  let unique = [...new Map(eligible.map((target) => [JSON.stringify(target), target])).values()];
  if (targets.length === 0 && resolved?.startsWith("refs/heads/")) {
    return { remote: ".", mergeRef: resolved, revision: resolved };
  }
  if (
    unique.length > 1 &&
    (resolved ||
      display.startsWith("refs/") ||
      new Set(unique.map((target) => target.remote)).size !== 1 ||
      new Set(unique.map((target) => target.revision)).size !== unique.length)
  ) {
    return null;
  }
  if (unique.length === 1 && isFullGitObjectId(unique[0]!.mergeRef)) {
    // Git recognizes exact object sources only in the repository’s object format.
    // They need no advertised name; fetch still verifies object availability.
    const format = await readGit("rev-parse", "--show-object-format");
    const hexLength = format === "sha256" ? 64 : format === "sha1" ? 40 : null;
    if (unique[0]!.mergeRef.length === hexLength) {
      return unique[0] ?? null;
    }
  }
  if (fetchRemote && unique.length > 0) {
    const remote = unique[0]!.remote;
    const advertised = await readGit(
      "ls-remote",
      "--",
      remote,
      ...new Set(
        unique.flatMap((target) =>
          gitRefSpellings(!target.mergeRef || target.mergeRef === "@" ? "HEAD" : target.mergeRef),
        ),
      ),
    );
    // Empty successful advertisement proves absence; null is a transport failure,
    // never permission to switch away from an otherwise unambiguous custom source.
    if (advertised !== null) {
      const refs = new Set(advertised.split("\n").map((line) => line.split("\t")[1]));
      unique = unique.filter((target) => {
        const source = gitRefSpellings(
          !target.mergeRef || target.mergeRef === "@" ? "HEAD" : target.mergeRef,
        ).find((ref) => refs.has(ref));
        // Keep the original source spelling for fetch: +main:dest is not +refs/heads/main:dest.
        return source !== undefined && !isExcluded(target, source);
      });
    }
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
