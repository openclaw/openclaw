import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import type {
  GitCheckoutContext,
  GitMergedPullHead as MergedPullHead,
} from "../infra/git-read-operations.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import { recordSessionPrDiagnostic } from "./control-ui-session-pr-diagnostics.js";
import {
  finishPullRequest,
  loadBoundSessionPullRequest,
  parsePullListItem,
  pullRequestMetadataSignature,
  stateOnlyPullRequestChip,
  readSessionPullRequestMetadata,
} from "./control-ui-session-pr-metadata.js";
import type { ControlUiSessionPrReadContext } from "./control-ui-session-pr-read.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import { sessionPullRequestRepositoryApiUrl } from "./control-ui-session-prs-checks.js";
import { readTaskPullRequestReceipts } from "./control-ui-session-task-prs.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { resolveGitHubForkParent } from "./github-repository-target.js";

const SUCCESS_CACHE_MS = 90_000;
// Back off refetches while GitHub reports quota exhaustion; the UI keeps
// showing the last-known chips with the stale warning during this window.
const RATE_LIMIT_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const MAX_PULL_REQUESTS = 3;

export type ControlUiSessionPullRequestsParams = {
  sessionKey: string;
  agentId?: string;
  refresh?: boolean;
};

type PullListItem = NonNullable<ReturnType<typeof parsePullListItem>>;

/**
 * Cached GitHub snapshot plus the merged PRs' heads. The heads stay
 * gateway-internal (stripped before responding): they only exist so branch
 * resolution can tell a landed tip from real post-merge work. Kept as raw
 * GitHub facts because the cache key carries no default branch; each
 * checkout filters them against its own default at resolve time.
 */
type BranchPullRequestsSnapshot = ControlUiSessionPullRequests & {
  publicationCandidates: ControlUiSessionPullRequest[];
  mergedHeads: MergedPullHead[];
  workingBranchHasLivePullRequest: boolean;
};

type CacheEntry = {
  access: ReturnType<typeof createGitHubReadGroup>;
  expiresAt: number;
  promise: Promise<BranchPullRequestsSnapshot>;
  refreshMode: "normal" | "forced" | null;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: Pick<
    BranchPullRequestsSnapshot,
    | "pullRequests"
    | "publicationCandidates"
    | "mergedHeads"
    | "repository"
    | "workingBranchHasLivePullRequest"
  >;
};

const branchCache = createRetainedCache<CacheEntry>();

function branchCacheKey(
  context: GitCheckoutContext,
  read: Pick<
    ReturnType<typeof prepareSessionPullRequestGitHubRead>,
    "host" | "apiBaseUrl" | "cacheScope"
  >,
  sessionIdentity: string,
): string {
  return JSON.stringify([
    read.host,
    read.apiBaseUrl,
    context.owner.toLowerCase(),
    context.repo.toLowerCase(),
    context.branch,
    sessionIdentity,
    read.cacheScope,
  ]);
}

/** Historical landing facts remain scoped to the current session, source, and credential. */
export function readKnownSessionBranchMergedHeads(
  context: GitCheckoutContext,
  read: ControlUiSessionPrReadContext,
): readonly MergedPullHead[] {
  read.assertCurrent();
  const access = prepareSessionPullRequestGitHubRead(
    context.host ?? "github.com",
    read.assertCurrent,
  );
  const entry = branchCache.get(
    branchCacheKey(
      context,
      access,
      JSON.stringify([read.target.branchIdentity ?? read.target.identity, read.sourceIdentity]),
    ),
  );
  access.assertCurrent();
  return structuredClone(entry?.lastGood?.mergedHeads ?? []);
}

type LoadSessionPullRequestDeps = {
  read: ControlUiSessionPrReadContext;
  cacheSignal?: AbortSignal;
};

// git push's own "create a pull request" hint URL; GitHub resolves the base
// branch (including fork -> parent) so no API call is needed to build it.
function branchCreateUrl(context: GitCheckoutContext, branchName: string): string {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const branch = branchName.split("/").map(encodeURIComponent).join("/");
  return `https://${context.host ?? "github.com"}/${owner}/${repo}/pull/new/${branch}`;
}

async function resolveSessionBranch(
  context: GitCheckoutContext,
  mergedHeads: readonly MergedPullHead[],
  refresh: boolean,
  refreshIndex: boolean,
): Promise<ControlUiSessionBranch | undefined> {
  if (!context.branch || context.branch === context.defaultBranch) {
    return undefined;
  }
  const root = context.root;
  if (!root) {
    // Repository-only sessions have no local checkout to inspect. Their recorded
    // source still exposes publication; the broker validates the accepted checkpoint.
    return {
      owner: context.owner,
      repo: context.repo,
      branch: context.branch,
      createUrl: branchCreateUrl(context, context.branch),
    };
  }
  const facts = await runGitReadOperation(
    {
      type: "pull-request.branch-facts",
      input: {
        root,
        branch: context.branch,
        defaultBranch: context.defaultBranch,
        mergedHeads,
        refreshIndex,
      },
    },
    { refresh },
  );
  if (!facts) {
    return undefined;
  }
  return {
    owner: context.owner,
    repo: context.repo,
    branch: context.branch,
    ...(facts.creatable ? { createUrl: branchCreateUrl(context, context.branch) } : {}),
    ...(facts.stats
      ? {
          additions: facts.stats.additions,
          deletions: facts.stats.deletions,
          changedFiles: facts.stats.changedFiles,
        }
      : {}),
  };
}

function parsePullList(value: unknown, host: string): PullListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parsePullListItem).filter((item): item is PullListItem => {
    if (!item) {
      return false;
    }
    const url = URL.parse(item.url);
    if (url?.protocol !== "https:" || url.username || url.password || url.hostname !== host) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        502,
        "GitHub returned a pull request for another host",
      );
    }
    return true;
  });
}

function pullsByHeadUrl(owner: string, repo: string, head: string, apiBaseUrl: string): string {
  const encHead = encodeURIComponent(head);
  return `${sessionPullRequestRepositoryApiUrl({ owner, repo, apiBaseUrl })}/pulls?head=${encHead}&state=all&sort=updated&direction=desc&per_page=5`;
}

function mergedHeadsOf(items: readonly PullListItem[]): MergedPullHead[] {
  const heads: MergedPullHead[] = [];
  for (const item of items) {
    if (item.state === "merged" && item.headSha) {
      heads.push({
        sha: item.headSha.toLowerCase(),
        ...(item.baseRef ? { baseRef: item.baseRef } : {}),
        ...(item.mergeCommitSha ? { mergeCommitSha: item.mergeCommitSha.toLowerCase() } : {}),
      });
    }
  }
  return heads;
}

async function fetchBranchPullRequests(
  context: GitCheckoutContext,
  read: ReturnType<typeof prepareSessionPullRequestGitHubRead>,
  refresh: boolean,
): Promise<BranchPullRequestsSnapshot> {
  const head = `${context.owner}:${context.branch}`;
  let items = parsePullList(
    await read.request(pullsByHeadUrl(context.owner, context.repo, head, read.apiBaseUrl)),
    read.host,
  );
  if (items.length === 0) {
    // Fork flow: the branch lives on the fork but PRs open against the parent.
    const parent = resolveGitHubForkParent(
      await read.request(
        sessionPullRequestRepositoryApiUrl({ ...context, apiBaseUrl: read.apiBaseUrl }),
      ),
    );
    if (parent) {
      items = parsePullList(
        await read.request(pullsByHeadUrl(parent.owner, parent.repo, head, read.apiBaseUrl)),
        read.host,
      );
    }
  }
  // Landing detection needs every fetched merged head, not just the displayed
  // slice: a squash-merged PR sorted past the cap still proves the tip landed.
  const mergedHeads = mergedHeadsOf(items);
  const isActive = (item: PullListItem) => item.state === "open" || item.state === "draft";
  const workingBranchHasLivePullRequest = items.some(isActive);
  const capped = items
    .toSorted((left, right) => Number(isActive(right)) - Number(isActive(left)))
    .slice(0, MAX_PULL_REQUESTS);
  const branchOf = (item: PullListItem) => item.branch ?? context.branch ?? "";
  // The display cap must not discard evidence needed by publication recovery.
  const publicationCandidates = items.map((item) => stateOnlyPullRequestChip(item, branchOf(item)));
  let pullRequests: ControlUiSessionPullRequest[];
  let rateLimited = false;
  try {
    pullRequests = await Promise.all(
      capped.map((item) =>
        readSessionPullRequestMetadata(
          item,
          read,
          (transport) => finishPullRequest(item, branchOf(item), transport),
          {
            refresh,
            expected: pullRequestMetadataSignature(stateOnlyPullRequestChip(item, branchOf(item))),
          },
        ),
      ),
    );
  } catch (error) {
    if (!(error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429)) {
      throw error;
    }
    // Quota ran out between the list fetch and the per-PR detail fetches:
    // keep the proven PR list as state-only chips instead of dropping it, or
    // a cold cache would show a Create PR row despite a known open PR.
    pullRequests = capped.map((item) => stateOnlyPullRequestChip(item, branchOf(item)));
    rateLimited = true;
  }
  return {
    pullRequests,
    rateLimited,
    publicationCandidates,
    mergedHeads,
    workingBranchHasLivePullRequest,
  };
}

async function refreshBranchPullRequests(
  context: GitCheckoutContext,
  read: ReturnType<typeof prepareSessionPullRequestGitHubRead>,
  entry: CacheEntry,
): Promise<BranchPullRequestsSnapshot> {
  const repository = { owner: context.owner, repo: context.repo };
  try {
    const result = {
      ...(await fetchBranchPullRequests(context, read, entry.refreshMode === "forced")),
      repository,
    };
    if (result.rateLimited) {
      entry.expiresAt = Date.now() + RATE_LIMIT_CACHE_MS;
      if (entry.lastGood) {
        const identity = (item: ControlUiSessionPullRequest) =>
          `${item.owner}/${item.repo}#${item.number}`.toLowerCase();
        const retained = new Map(entry.lastGood.pullRequests.map((item) => [identity(item), item]));
        const fresh = result.pullRequests.map((item) => {
          const previous = retained.get(identity(item));
          retained.delete(identity(item));
          return previous &&
            item.state === previous.state &&
            item.headSha === previous.headSha &&
            (item.state === "open" || item.state === "draft")
            ? { ...previous, ...item }
            : item;
        });
        result.pullRequests = [...fresh, ...retained.values()].slice(0, MAX_PULL_REQUESTS);
      }
    }
    // Degraded state-only chips still become lastGood: a later refresh that
    // rate-limits at the list fetch must serve the proven PRs, not an empty
    // list that would resurrect the Create PR row mid-outage. The shortened
    // expiry makes the next window retry full detail.
    const { rateLimited: _rateLimited, ...lastGood } = result;
    entry.lastGood = lastGood;
    return result;
  } catch (error) {
    read.assertCurrent();
    const rateLimited =
      error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429;
    entry.expiresAt = Date.now() + (rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
    if (rateLimited) {
      return {
        pullRequests: [],
        publicationCandidates: [],
        mergedHeads: [],
        workingBranchHasLivePullRequest: false,
        ...entry.lastGood,
        repository,
        rateLimited: true,
      };
    }
    if (entry.lastGood) {
      return { ...entry.lastGood, rateLimited: false, status: "unavailable" };
    }
    throw error;
  }
}

export async function loadControlUiSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps,
): Promise<ControlUiSessionPullRequests> {
  recordSessionPrDiagnostic("load-entered", deps.read.target);
  if (deps.read.target.ownGitHubProfileId && deps.read.target.taskReceiptsOnly) {
    return {
      ...(deps.read.branchSnapshot ?? { pullRequests: [], rateLimited: false }),
      branchRead: false,
    };
  }
  // Publication controls deliberately consume the current branch only.
  if (
    deps.read.projection === "publication" ||
    !deps.read.target.taskReceipts ||
    deps.read.target.ownGitHubProfileId
  ) {
    return loadControlUiSessionBranchPullRequests(params, deps);
  }
  recordSessionPrDiagnostic("branch-started", deps.read.target);
  const branch: ControlUiSessionPullRequests = deps.read.target.taskReceiptsOnly
    ? (deps.read.branchSnapshot ?? { pullRequests: [], rateLimited: false })
    : await loadControlUiSessionBranchPullRequests(params, deps).catch(() => ({
        pullRequests: [],
        rateLimited: false,
        status: "unavailable" as const,
      }));
  recordSessionPrDiagnostic("branch-returned", deps.read.target);
  if (!deps.read.target.taskReceiptsOnly) {
    deps.read.onBranchRead?.(branch);
  }
  recordSessionPrDiagnostic("receipts-started", deps.read.target);
  const task = await readTaskPullRequestReceipts(
    {
      ...deps.read.target.taskReceipts,
      ...(branch.pullRequests.length
        ? { branchUrls: [...new Set(branch.pullRequests.map((pr) => pr.url))] }
        : {}),
    },
    deps.read.assertCurrent,
    deps.cacheSignal,
  );
  recordSessionPrDiagnostic("receipts-returned", deps.read.target, {
    count: task.taskPullRequests.length,
  });
  if (deps.read.target.taskReceiptsOnly) {
    recordSessionPrDiagnostic("load-returned", deps.read.target);
    return {
      ...branch,
      taskPullRequests: task.taskPullRequests,
      taskPullRequestCount: task.taskPullRequestCount,
      ...(deps.read.branchSnapshot ? { pullRequestCount: task.pullRequestCount } : {}),
      branchRead: false,
    };
  }
  const taskPullRequests = [];
  let taskMetadataUnavailable = false;
  // Preview work is bounded by the receipt reader, and the subscription owner supplies concurrency.
  for (const known of task.taskPullRequests) {
    const url = new URL(known.url);
    if (url.hostname !== "github.com" && url.hostname !== deps.read.target.githubHost) {
      taskPullRequests.push(known);
      continue;
    }
    let pullRequest: ControlUiSessionPullRequest | undefined;
    try {
      const read = prepareSessionPullRequestGitHubRead(url.hostname, deps.read.assertCurrent, {
        signal: deps.cacheSignal,
      });
      recordSessionPrDiagnostic("metadata-started", deps.read.target, {
        count: taskPullRequests.length,
      });
      pullRequest = await readSessionPullRequestMetadata(
        known,
        read,
        async (transport) => {
          const details = await transport.request(
            sessionPullRequestRepositoryApiUrl({ ...known, apiBaseUrl: transport.apiBaseUrl }) +
              "/pulls/" +
              known.number,
          );
          const item = parsePullListItem(details);
          if (
            !item ||
            item.number !== known.number ||
            item.owner.toLowerCase() !== known.owner.toLowerCase() ||
            item.repo.toLowerCase() !== known.repo.toLowerCase() ||
            new URL(item.url).hostname !== url.hostname
          ) {
            throw new Error("GitHub returned another task pull request");
          }
          return finishPullRequest(item, item.branch ?? known.branch, transport, details);
        },
        {
          refresh: params.refresh,
          signal: deps.cacheSignal,
          retainFailure: () => true,
          onRetainedFailure: () => {
            taskMetadataUnavailable = true;
          },
        },
      );
    } catch {
      // A durable publication URL remains useful on a cold or rate-limited lookup.
      taskMetadataUnavailable = true;
      deps.read.assertCurrent();
    }
    recordSessionPrDiagnostic("metadata-returned", deps.read.target, {
      count: taskPullRequests.length,
      current: Boolean(pullRequest),
    });
    taskPullRequests.push({ ...known, ...(pullRequest ? { pullRequest } : {}) });
  }
  deps.read.assertCurrent();
  recordSessionPrDiagnostic("load-returned", deps.read.target);
  return {
    ...branch,
    taskPullRequests,
    taskPullRequestCount: task.taskPullRequestCount,
    pullRequestCount: task.pullRequestCount,
    ...(taskMetadataUnavailable && !branch.rateLimited ? { status: "unavailable" as const } : {}),
  };
}

async function loadControlUiSessionBranchPullRequests(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps,
): Promise<ControlUiSessionPullRequests> {
  const { target, assertCurrent, projection } = deps.read;
  try {
    assertCurrent();
    const request = { ...params, ...target.params };
    const ownProfileId = target.ownGitHubProfileId;
    const binding = target.githubPullRequest;
    if (binding && projection !== "publication") {
      try {
        if (!binding.preparedHeadCommit || binding.host !== target.githubHost) {
          throw new Error("The session pull request is not prepared on the current host");
        }
        let credential:
          | import("./control-ui-session-pr-request.js").SessionPullRequestReadCredential
          | undefined;
        let preparedDetails: unknown;
        if (ownProfileId) {
          const { readOwnGitHubPullRequest } = await import("./github-publication-inspect.js");
          const inspected = await readOwnGitHubPullRequest({
            pullRequestUrl: binding.url,
            agentId: target.params.agentId,
            reader: captureOwnGitHubPullRequestReader(ownProfileId, () => binding.host),
            assertCurrent,
          });
          inspected.assertCurrent();
          const selected = inspected.result;
          if (
            !inspected.credential ||
            selected.url !== binding.url ||
            selected.host !== binding.host ||
            selected.number !== binding.number ||
            selected.base.repositoryId !== binding.base.repositoryId ||
            (selected.head &&
              (selected.head.repositoryId !== binding.head.repositoryId ||
                selected.head.branch !== binding.head.branch))
          ) {
            throw new Error("The session pull request association changed");
          }
          credential = inspected.credential;
          preparedDetails = inspected.details;
          deps.read.retainReadAuthority?.(inspected.assertIdentityCurrent, credential);
        }
        const read = prepareSessionPullRequestGitHubRead(binding.host, assertCurrent, {
          signal: deps.cacheSignal,
          credential,
        });
        let unavailable = false;
        let rateLimited = false;
        const pullRequest = await loadBoundSessionPullRequest(binding, read, {
          bindingIdentity: JSON.stringify([target.identity, deps.read.sourceIdentity]),
          refresh: request.refresh,
          signal: deps.cacheSignal,
          preparedDetails,
          onRetainedFailure: (error) => {
            unavailable = true;
            rateLimited =
              error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429;
          },
        });
        assertCurrent();
        return {
          pullRequests: [pullRequest],
          repository: { owner: pullRequest.owner, repo: pullRequest.repo },
          rateLimited,
          ...(unavailable && !rateLimited ? { status: "unavailable" as const } : {}),
        };
      } catch (error) {
        assertCurrent();
        const rateLimited =
          error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429;
        // Quota exhaustion withholds nothing that was verified; the UI keeps the last card with a warning.
        return rateLimited
          ? { pullRequests: [], rateLimited: true, status: "rate-limited" }
          : { pullRequests: [], discardPrevious: true, rateLimited: false, status: "unavailable" };
      }
    }
    const source = target.source;
    recordSessionPrDiagnostic("context-started", target);
    const context =
      typeof source === "string"
        ? await runGitReadOperation(
            {
              type: "checkout.context",
              input: { root: source, githubHost: deps.read.target.githubHost },
            },
            { refresh: request.refresh },
          )
        : source;
    recordSessionPrDiagnostic("context-returned", target);
    assertCurrent();
    if (!context) {
      branchCache.release(deps.cacheSignal);
      return { pullRequests: [], rateLimited: false };
    }
    // Publication controls select the current checkout branch only. Task history
    // is projected separately from the publication owner's receipts.
    if (!context.branch || context.branch === context.defaultBranch) {
      branchCache.release(deps.cacheSignal);
      return {
        pullRequests: [],
        repository: { owner: context.owner, repo: context.repo },
        rateLimited: false,
      };
    }
    recordSessionPrDiagnostic("branch-cache-started", target);
    const result = await cachedBranchPullRequests(
      context,
      deps,
      request.refresh === true,
      JSON.stringify([target.branchIdentity ?? target.identity, deps.read.sourceIdentity]),
    ).catch(() => null);
    recordSessionPrDiagnostic("branch-cache-returned", target);
    assertCurrent();
    if (!result) {
      // Local repository identity survives a cold PR lookup failure, but an
      // unknown PR list must not enable a Create PR row.
      return {
        pullRequests: [],
        repository: { owner: context.owner, repo: context.repo },
        rateLimited: false,
        status: "unavailable",
      };
    }
    const { publicationCandidates, mergedHeads, workingBranchHasLivePullRequest, ...snapshot } =
      result;
    recordSessionPrDiagnostic("branch-facts-started", target);
    const branch =
      projection === "publication" || workingBranchHasLivePullRequest
        ? undefined
        : await resolveSessionBranch(
            context,
            mergedHeads,
            request.refresh === true,
            target.refreshIndex === true,
          );
    recordSessionPrDiagnostic("branch-facts-returned", target);
    assertCurrent();
    return {
      ...snapshot,
      pullRequests: projection === "publication" ? publicationCandidates : snapshot.pullRequests,
      ...(branch ? { branch } : {}),
    };
  } catch (error) {
    branchCache.release(deps.cacheSignal);
    throw error;
  }
}

function trackBranchRefresh(
  entry: CacheEntry,
  mode: "normal" | "forced",
  load: () => Promise<BranchPullRequestsSnapshot>,
): Promise<BranchPullRequestsSnapshot> {
  // Publish the replacement promise before any awaited work so later callers
  // cannot overtake a queued forced refresh with an older normal result.
  entry.expiresAt = Date.now() + SUCCESS_CACHE_MS;
  entry.refreshMode = mode;
  const refreshPromise = load();
  const trackedPromise = refreshPromise.finally(() => {
    if (entry.promise === trackedPromise) {
      entry.refreshMode = null;
    }
  });
  entry.promise = trackedPromise;
  return trackedPromise;
}

async function cachedBranchPullRequests(
  context: GitCheckoutContext,
  deps: LoadSessionPullRequestDeps,
  refresh: boolean,
  sessionIdentity: string,
): Promise<BranchPullRequestsSnapshot> {
  let read: ReturnType<typeof prepareSessionPullRequestGitHubRead>;
  try {
    read = prepareSessionPullRequestGitHubRead(
      context.host ?? "github.com",
      deps.read.assertCurrent,
    );
  } catch (error) {
    branchCache.release(deps.cacheSignal);
    throw error;
  }
  // Keep proven branch state and quota backoff scoped to this session/source
  // generation, independently of other sessions using the same branch.
  const key = branchCacheKey(context, read, sessionIdentity);
  const cached = branchCache.get(key, deps.cacheSignal);
  const entry: CacheEntry = cached ?? {
    access: createGitHubReadGroup(),
    expiresAt: 0,
    promise: Promise.resolve({
      pullRequests: [],
      publicationCandidates: [],
      rateLimited: false,
      mergedHeads: [],
      workingBranchHasLivePullRequest: false,
    }),
    refreshMode: null,
  };
  const reusable = entry.expiresAt > Date.now() && !entry.access.signal.aborted;
  if (entry.access.signal.aborted) {
    entry.access = createGitHubReadGroup();
  }
  const release = entry.access.add(read.assertCurrent, deps.cacheSignal);
  const transportRead = prepareSessionPullRequestGitHubRead(read.host, entry.access.assertCurrent, {
    signal: entry.access.signal,
  });
  try {
    if (reusable) {
      branchCache.set(key, entry, deps.cacheSignal);
      if (!refresh || entry.refreshMode === "forced") {
        return await racePromiseWithAbortSignal(entry.promise, deps.cacheSignal);
      }
      const pendingSnapshot = entry.promise;
      const pendingRefreshMode = entry.refreshMode;
      const pendingExpiresAt = entry.expiresAt;
      return await racePromiseWithAbortSignal(
        trackBranchRefresh(entry, "forced", async () => {
          const snapshot = await pendingSnapshot;
          transportRead.assertCurrent();
          // Forced refreshes retain quota backoff from the shared preceding request.
          if (snapshot.rateLimited) {
            if (pendingRefreshMode === null) {
              entry.expiresAt = pendingExpiresAt;
            }
            return snapshot;
          }
          return refreshBranchPullRequests(context, transportRead, entry);
        }),
        deps.cacheSignal,
      );
    }
    const promise = trackBranchRefresh(entry, refresh ? "forced" : "normal", () =>
      refreshBranchPullRequests(context, transportRead, entry),
    );
    branchCache.set(key, entry, deps.cacheSignal);
    return await racePromiseWithAbortSignal(promise, deps.cacheSignal);
  } finally {
    release();
    read.assertCurrent();
  }
}
