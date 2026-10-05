import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import {
  githubPublicationApiArgs,
  requirePublicationCommand,
} from "./github-publication-git-transport.js";

type GitHubPublicationPullRequestLookup = {
  repository: string;
  pushOwner: string;
  branch: string;
  baseBranch: string;
  marker: string;
  host?: string;
  refreshIdentity: () => Promise<PreparedGitHubPublicationIdentity>;
  assertCurrent: () => void;
};

async function readGitHubPublicationApi(
  params: GitHubPublicationPullRequestLookup,
  endpoint: string,
  args: string[] = [],
) {
  const identity = await params.refreshIdentity();
  params.assertCurrent();
  const raw = await requirePublicationCommand(
    [
      ...githubPublicationApiArgs(
        endpoint,
        "GET",
        identity.host ?? params.host ?? resolveGitHubHost(),
      ),
      ...args,
    ],
    { env: identity.env },
  );
  return { identity, raw };
}

async function loadGitHubPublicationPullRequests(params: GitHubPublicationPullRequestLookup) {
  const marker = JSON.stringify(params.marker);
  const { identity, raw } = await readGitHubPublicationApi(
    params,
    `repos/${params.repository}/pulls`,
    [
      "-f",
      `head=${params.pushOwner}:${params.branch}`,
      "-f",
      `base=${params.baseBranch}`,
      "-f",
      "state=all",
      "--paginate",
      "--jq",
      // Compact pages remain independently parseable; only the request marker is needed from prose.
      `map({url: .html_url, userId: .user.id, state: .state, body: (if ((.body // "") | contains(${marker})) then ${marker} else "" end), headSha: .head.sha, headRef: .head.ref, baseRef: .base.ref}) | tojson`,
    ],
  );
  return { identity, candidates: parseGitHubPublicationPullRequests(raw) };
}

/** Parses the complete authenticated PR lookup; one malformed candidate invalidates the response. */
function parseGitHubPublicationPullRequests(raw: string) {
  let pages: unknown[];
  try {
    pages = raw
      .trim()
      .split(/\r?\n/u)
      .map((page) => JSON.parse(page));
  } catch (error) {
    throw new Error("GitHub pull request lookup returned invalid JSON.", { cause: error });
  }
  const candidates: unknown[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      throw new Error("GitHub pull request lookup returned an invalid response.");
    }
    candidates.push(...page);
  }
  return candidates.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("GitHub pull request lookup returned an invalid candidate.");
    }
    const userId = candidate.userId;
    const url = readNonBlankString(candidate.url);
    const state = candidate.state;
    const body = candidate.body;
    const headSha = readNonBlankString(candidate.headSha);
    const headRef = readNonBlankString(candidate.headRef);
    const baseRef = readNonBlankString(candidate.baseRef);
    if (
      !Number.isSafeInteger(userId) ||
      Number(userId) < 1 ||
      !url ||
      (state !== "open" && state !== "closed") ||
      typeof body !== "string" ||
      !headSha ||
      !headRef ||
      !baseRef
    ) {
      throw new Error("GitHub pull request lookup returned an invalid candidate.");
    }
    return { userId: Number(userId), url, state, body, headSha, headRef, baseRef };
  });
}

export async function findGitHubPublicationPullRequest(
  params: GitHubPublicationPullRequestLookup & {
    headCommit: string;
    recordObserved?: (url: string) => void;
  },
): Promise<string | undefined> {
  const { identity, candidates } = await loadGitHubPublicationPullRequests(params);
  const exact = candidates.filter(
    (candidate) =>
      candidate.userId === identity.account.accountId &&
      candidate.headSha === params.headCommit &&
      candidate.headRef === params.branch &&
      candidate.baseRef === params.baseBranch,
  );
  const found =
    exact.find((candidate) => candidate.state === "open") ??
    exact.find(
      (candidate) => candidate.state === "closed" && candidate.body.includes(params.marker),
    );
  if (found) {
    params.recordObserved?.(found.url);
    if (found.state === "closed") {
      params.assertCurrent();
      throw new GitHubPublicationKnownFailure(
        "GitHub pull request was closed before publication completed.",
        {
          code: "github_rejected",
          nextAction:
            "Reopen the closed pull request or retry to create a new publication request.",
        },
      );
    }
  }
  const occupied = candidates.find(
    (candidate) =>
      candidate.state === "open" &&
      candidate.headRef === params.branch &&
      candidate.baseRef === params.baseBranch,
  );
  if (occupied && occupied.userId !== identity.account.accountId) {
    throw new GitHubPublicationKnownFailure("GitHub pull request is owned by another account.", {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    });
  }
  // A matching accepted result settles its receipt; later actions still check authority.
  if (found) {
    return found.url;
  }
  params.assertCurrent();
  return undefined;
}

/** Observe only the saved request's commit and PR; an absent response proves no non-execution. */
export async function reconcileGitHubPublicationPullRequest(
  params: Parameters<typeof findGitHubPublicationPullRequest>[0] & {
    requestId: string;
    pushRepository: string;
    workspaceTree: string;
    parentCommit: string;
    pushOnly?: "observed" | "dispatched";
    knownPullRequestUrls: readonly string[];
    recordPushObserved?: (headCommit: string) => void;
  },
): Promise<string | undefined> {
  const { raw } = await readGitHubPublicationApi(
    params,
    `repos/${params.pushRepository}/git/commits/${params.headCommit}`,
  );
  params.assertCurrent();
  const commit: unknown = JSON.parse(raw);
  const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;
  if (
    !isRecord(commit) ||
    commit.sha !== params.headCommit ||
    !isRecord(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !objectId.test(commit.tree.sha) ||
    !Array.isArray(commit.parents) ||
    typeof commit.message !== "string"
  ) {
    throw new Error("GitHub publication commit observation is invalid.");
  }
  const parents = commit.parents.map((parent) => {
    if (!isRecord(parent) || typeof parent.sha !== "string" || !objectId.test(parent.sha)) {
      throw new Error("GitHub publication commit observation is invalid.");
    }
    return parent.sha;
  });
  if (
    commit.tree.sha !== params.workspaceTree ||
    parents.length !== 1 ||
    parents[0] !== params.parentCommit ||
    !commit.message.split(/\r?\n/u).includes(`OpenClaw-Publication: ${params.requestId}`)
  ) {
    return undefined;
  }
  const includesCommit = async (head: string): Promise<boolean> => {
    if (head === params.headCommit) {
      return true;
    }
    if (!objectId.test(head)) {
      throw new Error("GitHub publication head observation is invalid.");
    }
    const { raw: comparisonRaw } = await readGitHubPublicationApi(
      params,
      `repos/${params.pushRepository}/compare/${params.headCommit}...${head}?per_page=1`,
      ["--jq", "{sha: .merge_base_commit.sha}"],
    );
    const comparison: unknown = JSON.parse(comparisonRaw);
    if (
      !isRecord(comparison) ||
      typeof comparison.sha !== "string" ||
      !objectId.test(comparison.sha)
    ) {
      throw new Error("GitHub publication ancestry observation is invalid.");
    }
    return comparison.sha === params.headCommit;
  };
  const { identity: lookupIdentity, candidates } = await loadGitHubPublicationPullRequests(params);
  let unrelated = false;
  for (const candidate of candidates) {
    if (
      candidate.userId !== lookupIdentity.account.accountId ||
      candidate.headRef !== params.branch ||
      candidate.baseRef !== params.baseBranch ||
      (!candidate.body.includes(params.marker) &&
        !params.knownPullRequestUrls.includes(candidate.url) &&
        !(params.pushOnly && candidate.state === "open"))
    ) {
      continue;
    }
    if (await includesCommit(candidate.headSha)) {
      params.recordObserved?.(candidate.url);
      return candidate.url;
    }
    unrelated = true;
  }
  if (!params.pushOnly || unrelated) {
    throw new Error("The original GitHub pull request has not been confirmed.");
  }
  if (params.pushOnly === "observed") {
    return undefined;
  }
  const { raw: refsRaw } = await readGitHubPublicationApi(
    params,
    `repos/${params.pushRepository}/git/matching-refs/heads/${encodeURIComponent(params.branch)}`,
  );
  const refs: unknown = JSON.parse(refsRaw);
  if (!Array.isArray(refs)) {
    throw new Error("GitHub publication branch observation is invalid.");
  }
  const ref = refs.find((value) => isRecord(value) && value.ref === `refs/heads/${params.branch}`);
  if (
    !isRecord(ref) ||
    !isRecord(ref.object) ||
    typeof ref.object.sha !== "string" ||
    !(await includesCommit(ref.object.sha))
  ) {
    throw new Error("The original GitHub push has not been confirmed.");
  }
  params.recordPushObserved?.(params.headCommit);
  return undefined;
}
