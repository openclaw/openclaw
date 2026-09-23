import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";

type GitHubPublicationPullRequest = {
  userId: number;
  url: string;
  state: "open" | "closed";
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
};

function githubPublicationPullRequestLookupArgs(params: {
  repository: string;
  owner: string;
  branch: string;
  baseBranch: string;
  marker: string;
}): string[] {
  const marker = JSON.stringify(params.marker);
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    `repos/${params.repository}/pulls`,
    "-f",
    `head=${params.owner}:${params.branch}`,
    "-f",
    `base=${params.baseBranch}`,
    "-f",
    "state=all",
    "--paginate",
    "--jq",
    // Compact pages remain independently parseable; only the request marker is needed from prose.
    `map({url: .html_url, userId: .user.id, state: .state, body: (if ((.body // "") | contains(${marker})) then ${marker} else "" end), headSha: .head.sha, headRef: .head.ref, baseRef: .base.ref}) | tojson`,
  ];
}

export function githubPublicationCreatePullRequestArgs(repository: string): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    `repos/${repository}/pulls`,
    "--input",
    "-",
  ];
}

/** Parses the complete authenticated PR lookup; one malformed candidate invalidates the response. */
function parseGitHubPublicationPullRequests(raw: string): GitHubPublicationPullRequest[] {
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

function resolveGitHubPublicationPullRequest(
  candidates: readonly GitHubPublicationPullRequest[],
  params: {
    accountId: number;
    headCommit: string;
    branch: string;
    baseBranch: string;
    marker: string;
  },
): GitHubPublicationPullRequest | undefined {
  const exact = candidates.filter(
    (candidate) =>
      candidate.userId === params.accountId &&
      candidate.headSha === params.headCommit &&
      candidate.headRef === params.branch &&
      candidate.baseRef === params.baseBranch,
  );
  const open = exact.find((candidate) => candidate.state === "open");
  return (
    open ??
    exact.find(
      (candidate) => candidate.state === "closed" && candidate.body.includes(params.marker),
    )
  );
}

export async function findGitHubPublicationPullRequest(params: {
  repository: string;
  pushOwner: string;
  branch: string;
  baseBranch: string;
  headCommit: string;
  marker: string;
  refreshIdentity: () => Promise<PreparedGitHubPublicationIdentity>;
  recordObserved?: (url: string) => void;
  assertCurrent: () => void;
}): Promise<string | undefined> {
  const identity = await params.refreshIdentity();
  params.assertCurrent();
  const raw = await requirePublicationCommand(
    githubPublicationPullRequestLookupArgs({
      repository: params.repository,
      owner: params.pushOwner,
      branch: params.branch,
      baseBranch: params.baseBranch,
      marker: params.marker,
    }),
    { env: identity.env },
  );
  const candidates = parseGitHubPublicationPullRequests(raw);
  const found = resolveGitHubPublicationPullRequest(candidates, {
    accountId: identity.account.accountId,
    headCommit: params.headCommit,
    branch: params.branch,
    baseBranch: params.baseBranch,
    marker: params.marker,
  });
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
  const identity = await params.refreshIdentity();
  params.assertCurrent();
  const raw = await requirePublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      `repos/${params.pushRepository}/git/commits/${params.headCommit}`,
    ],
    { env: identity.env },
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
    const currentIdentity = await params.refreshIdentity();
    params.assertCurrent();
    const comparison: unknown = JSON.parse(
      await requirePublicationCommand(
        [
          "gh",
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          `repos/${params.pushRepository}/compare/${params.headCommit}...${head}?per_page=1`,
          "--jq",
          "{sha: .merge_base_commit.sha}",
        ],
        { env: currentIdentity.env },
      ),
    );
    if (
      !isRecord(comparison) ||
      typeof comparison.sha !== "string" ||
      !objectId.test(comparison.sha)
    ) {
      throw new Error("GitHub publication ancestry observation is invalid.");
    }
    return comparison.sha === params.headCommit;
  };
  const lookupIdentity = await params.refreshIdentity();
  params.assertCurrent();
  const candidates = parseGitHubPublicationPullRequests(
    await requirePublicationCommand(
      githubPublicationPullRequestLookupArgs({
        repository: params.repository,
        owner: params.pushOwner,
        branch: params.branch,
        baseBranch: params.baseBranch,
        marker: params.marker,
      }),
      { env: lookupIdentity.env },
    ),
  );
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
  const refIdentity = await params.refreshIdentity();
  params.assertCurrent();
  const refs: unknown = JSON.parse(
    await requirePublicationCommand(
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        `repos/${params.pushRepository}/git/matching-refs/heads/${encodeURIComponent(params.branch)}`,
      ],
      { env: refIdentity.env },
    ),
  );
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
