import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import {
  githubPublicationApiArgs,
  requirePublicationCommand,
} from "./github-publication-git-transport.js";

export type PublishedGitHubPullRequest = { url: string; number: number; pushRepository: string };

type GitHubPublicationPullRequestLookup = {
  pullRequest?: SessionGitHubPullRequestBinding;
  publishedPullRequest?: PublishedGitHubPullRequest;
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
  params: Pick<GitHubPublicationPullRequestLookup, "host" | "refreshIdentity" | "assertCurrent">,
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

/** Read only the receipt-selected PR and verify both repository/branch boundaries. */
export async function readPublishedGitHubPullRequest(
  params: Pick<
    GitHubPublicationPullRequestLookup,
    "repository" | "branch" | "host" | "refreshIdentity" | "assertCurrent"
  > & {
    publishedPullRequest: PublishedGitHubPullRequest;
    baseBranch?: string;
    publisherAccountId?: number;
  },
) {
  const pr = params.publishedPullRequest;
  const { identity, raw } = await readGitHubPublicationApi(
    params,
    `repos/${params.repository}/pulls/${pr.number}`,
  );
  params.assertCurrent();
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.html_url !== pr.url ||
    value.number !== pr.number ||
    !isRecord(value.user) ||
    value.user.id !== (params.publisherAccountId ?? identity.account.accountId) ||
    !isRecord(value.head) ||
    !isRecord(value.head.repo) ||
    typeof value.head.repo.full_name !== "string" ||
    value.head.repo.full_name.toLowerCase() !== pr.pushRepository.toLowerCase() ||
    value.head.ref !== params.branch ||
    !isRecord(value.base) ||
    !isRecord(value.base.repo) ||
    typeof value.base.repo.full_name !== "string" ||
    value.base.repo.full_name.toLowerCase() !== params.repository.toLowerCase() ||
    (params.baseBranch !== undefined && value.base.ref !== params.baseBranch)
  ) {
    throw new Error("The original published pull request target changed.");
  }
  const [candidate] = parseGitHubPublicationPullRequests(
    JSON.stringify([
      {
        url: value.html_url,
        userId: value.user.id,
        state: value.state,
        body: value.body ?? "",
        headSha: value.head.sha,
        headRef: value.head.ref,
        baseRef: value.base.ref,
      },
    ]),
  );
  return { identity, candidate: candidate! };
}

async function loadGitHubPublicationPullRequests(
  params: Omit<GitHubPublicationPullRequestLookup, "baseBranch"> & { baseBranch?: string },
) {
  if (params.pullRequest) {
    const pr = params.pullRequest;
    const { identity, raw } = await readGitHubPublicationApi(
      params,
      `repos/${pr.base.repository}/pulls/${pr.number}`,
      [
        "--jq",
        '{url: .html_url, userId: .user.id, state: .state, body: "", headSha: .head.sha, headRef: .head.ref, baseRef: .base.ref, headRepository: .head.repo.full_name, headRepositoryId: .head.repo.id, baseRepository: .base.repo.full_name, baseRepositoryId: .base.repo.id}',
      ],
    );
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.url !== pr.url ||
      value.headRepository !== pr.head.repository ||
      value.headRepositoryId !== pr.head.repositoryId ||
      value.baseRepository !== pr.base.repository ||
      value.baseRepositoryId !== pr.base.repositoryId ||
      value.headRef !== pr.head.branch ||
      value.baseRef !== pr.base.branch
    ) {
      throw new Error("The original GitHub pull request target changed.");
    }
    return { identity, candidates: parseGitHubPublicationPullRequests(JSON.stringify([value])) };
  }
  if (params.publishedPullRequest) {
    const { identity, candidate } = await readPublishedGitHubPullRequest({
      ...params,
      publishedPullRequest: params.publishedPullRequest,
    });
    return { identity, candidates: [candidate] };
  }
  const marker = JSON.stringify(params.marker);
  const { identity, raw } = await readGitHubPublicationApi(
    params,
    `repos/${params.repository}/pulls`,
    [
      "-f",
      `head=${params.pushOwner}:${params.branch}`,
      ...(params.baseBranch ? ["-f", `base=${params.baseBranch}`] : []),
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
    pages = raw.split(/\r?\n/u).map((page) => JSON.parse(page));
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

function matchingGitHubPublicationHeads(
  params: Omit<GitHubPublicationPullRequestLookup, "baseBranch"> & {
    headCommit: string;
    baseBranch?: string;
  },
  lookup: Awaited<ReturnType<typeof loadGitHubPublicationPullRequests>>,
) {
  return lookup.candidates.filter(
    (candidate) =>
      (params.pullRequest || candidate.userId === lookup.identity.account.accountId) &&
      candidate.headSha === params.headCommit &&
      candidate.headRef === params.branch &&
      (params.baseBranch === undefined || candidate.baseRef === params.baseBranch),
  );
}

export async function findGitHubPublicationPullRequest(
  params: GitHubPublicationPullRequestLookup & {
    headCommit: string;
    recordObserved?: (url: string) => void | Promise<void>;
  },
): Promise<string | undefined> {
  const { identity, candidates } = await loadGitHubPublicationPullRequests(params);
  if (params.publishedPullRequest && candidates.some((candidate) => candidate.state === "closed")) {
    throw new GitHubPublicationKnownFailure("The original published pull request was closed.", {
      code: "github_rejected",
      nextAction: "Inspect the original pull request before requesting another publication.",
    });
  }
  const exact = matchingGitHubPublicationHeads(params, { identity, candidates });
  const found =
    exact.find((candidate) => candidate.state === "open") ??
    exact.find(
      (candidate) => candidate.state === "closed" && candidate.body.includes(params.marker),
    );
  if (found) {
    await params.recordObserved?.(found.url);
    if (found.state === "closed" && found.body.includes(params.marker)) {
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
  if (!params.pullRequest && occupied && occupied.userId !== identity.account.accountId) {
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
    beforeRetry?: boolean;
    knownPullRequestUrls: readonly string[];
    readContinuation?: () => Promise<
      Pick<GitHubPublicationPullRequestLookup, "publishedPullRequest" | "baseBranch"> | undefined
    >;
    recordPushObserved?: (headCommit: string) => void | Promise<void>;
  },
): Promise<string | undefined> {
  const lookup = { ...params, baseBranch: params.readContinuation ? undefined : params.baseBranch };
  const observed = params.beforeRetry ? await loadGitHubPublicationPullRequests(lookup) : undefined;
  if (
    observed &&
    !matchingGitHubPublicationHeads(lookup, observed).some(
      (candidate) => candidate.state === "open" || !candidate.body.includes(params.marker),
    )
  ) {
    // A prepared commit need not have reached GitHub. A missing match, a closed
    // first-publication PR or a foreign owner stays with the existing retry guards.
    return undefined;
  }
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
  let { identity: lookupIdentity, candidates } =
    observed ?? (await loadGitHubPublicationPullRequests(lookup));
  let baseBranch: string | undefined = params.baseBranch;
  let knownPullRequestUrls = params.knownPullRequestUrls;
  if (params.readContinuation) {
    // A request that created a new PR after closure owns its marker. Observe it
    // before consulting the previous publication, even if either PR was retargeted.
    candidates = candidates.filter(
      (candidate) =>
        candidate.userId === lookupIdentity.account.accountId &&
        candidate.headRef === params.branch &&
        candidate.body.includes(params.marker),
    );
    baseBranch = undefined;
    if (candidates.length === 0) {
      const continuation = await params.readContinuation();
      if (continuation?.publishedPullRequest) {
        ({ identity: lookupIdentity, candidates } = await loadGitHubPublicationPullRequests({
          ...params,
          ...continuation,
        }));
        baseBranch = continuation.baseBranch;
        knownPullRequestUrls = [continuation.publishedPullRequest.url];
      }
    }
  }
  let unrelated = false;
  for (const candidate of candidates) {
    if (
      (!params.pullRequest && candidate.userId !== lookupIdentity.account.accountId) ||
      candidate.headRef !== params.branch ||
      (baseBranch !== undefined && candidate.baseRef !== baseBranch) ||
      (!params.pullRequest &&
        !candidate.body.includes(params.marker) &&
        !knownPullRequestUrls.includes(candidate.url) &&
        !(params.pushOnly && candidate.state === "open"))
    ) {
      continue;
    }
    if (await includesCommit(candidate.headSha)) {
      await params.recordObserved?.(candidate.url);
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
  await params.recordPushObserved?.(params.headCommit);
  return undefined;
}
