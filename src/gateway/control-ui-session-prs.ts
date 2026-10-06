import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
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
import type { ControlUiSessionPrReadContext } from "./control-ui-session-pr-read.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import {
  fetchSessionPullRequestCheckRollup,
  sessionPullRequestRepositoryApiUrl,
} from "./control-ui-session-prs-checks.js";
import { gitHubPublicApi } from "./github-public-api.js";
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

type PullListItem = {
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  state: ControlUiSessionPullRequest["state"];
  author?: ControlUiSessionPullRequest["author"];
  branch?: string;
  headSha?: string;
  baseRef?: string;
  mergeCommitSha?: string;
};

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
    fetch,
    read.assertCurrent,
  );
  const entry = branchCache.get(
    branchCacheKey(context, access, JSON.stringify([read.target.identity, read.sourceIdentity])),
  );
  access.assertCurrent();
  return structuredClone(entry?.lastGood?.mergedHeads ?? []);
}

type LoadSessionPullRequestDeps = {
  read: ControlUiSessionPrReadContext;
  cacheSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveGitRoot?: (params: ControlUiSessionPullRequestsParams) => Promise<string | null>;
  resolveGitContext?: (
    params: ControlUiSessionPullRequestsParams,
  ) => Promise<GitCheckoutContext | null>;
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

function derivePullState(value: Record<string, unknown>): ControlUiSessionPullRequest["state"] {
  if (readNonBlankString(value.merged_at)) {
    return "merged";
  }
  if (value.state !== "open") {
    return "closed";
  }
  return value.draft === true ? "draft" : "open";
}

export function parsePullListItem(value: unknown): PullListItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const number = asFiniteNumber(value.number);
  const title = readNonBlankString(value.title);
  const url = readNonBlankString(value.html_url);
  const base = isRecord(value.base) ? value.base : {};
  const baseRepo = isRecord(base.repo) ? base.repo : {};
  const baseOwner = isRecord(baseRepo.owner) ? baseRepo.owner : {};
  const owner = readNonBlankString(baseOwner.login);
  const repo = readNonBlankString(baseRepo.name);
  const head = isRecord(value.head) ? value.head : {};
  if (!number || !Number.isSafeInteger(number) || number < 1 || !title || !url || !owner || !repo) {
    return null;
  }
  const user = isRecord(value.user) ? value.user : {};
  const authorLogin = readNonBlankString(user.login);
  return {
    number,
    title,
    url,
    owner,
    repo,
    state: derivePullState(value),
    ...(authorLogin ? { author: { login: authorLogin } } : {}),
    branch: readNonBlankString(head.ref),
    headSha: readNonBlankString(head.sha),
    baseRef: readNonBlankString(base.ref),
    mergeCommitSha: readNonBlankString(value.merge_commit_sha),
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

// Sub-fetch degradation: quota errors abort the whole refresh (so the caller
// serves stale chips with the rate-limit flag); anything else just drops the
// optional field the sub-fetch would have filled.
function rethrowRateLimit(error: unknown): undefined {
  if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429) {
    throw error;
  }
  return undefined;
}

/**
 * The facts a chip carries without spending quota on per-PR detail calls. The
 * rate-limited path renders exactly this, so both callers share one shape.
 */
function stateOnlyPullRequestChip(item: PullListItem, branch: string): ControlUiSessionPullRequest {
  return {
    number: item.number,
    owner: item.owner,
    repo: item.repo,
    branch,
    title: item.title,
    url: item.url,
    state: item.state,
    ...(item.headSha && /^[0-9a-f]{40}$/i.test(item.headSha)
      ? { headSha: item.headSha.toLowerCase() }
      : {}),
    ...(item.author ? { author: item.author } : {}),
  };
}

async function finishPullRequest(
  item: PullListItem,
  branch: string,
  read: ReturnType<typeof prepareSessionPullRequestGitHubRead>,
): Promise<ControlUiSessionPullRequest> {
  const chip = stateOnlyPullRequestChip(item, branch);
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const detailUrl = `${sessionPullRequestRepositoryApiUrl({ ...item, apiBaseUrl: read.apiBaseUrl })}/pulls/${item.number}`;
  const [details, checks] = await Promise.all([
    read.request(detailUrl).catch(rethrowRateLimit),
    fetchSessionPullRequestCheckRollup(
      { ...item, apiBaseUrl: read.apiBaseUrl },
      read.request,
    ).catch(rethrowRateLimit),
  ]);
  return {
    ...chip,
    ...(isRecord(details)
      ? {
          additions: asFiniteNumber(details.additions),
          deletions: asFiniteNumber(details.deletions),
          changedFiles: asFiniteNumber(details.changed_files),
        }
      : {}),
    ...(checks ? { checks, checksUrl: `${item.url}/checks` } : {}),
  };
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
      capped.map((item) => finishPullRequest(item, branchOf(item), read)),
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
      ...(await fetchBranchPullRequests(context, read)),
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
    entry.lastGood = {
      pullRequests: result.pullRequests,
      publicationCandidates: result.publicationCandidates,
      mergedHeads: result.mergedHeads,
      workingBranchHasLivePullRequest: result.workingBranchHasLivePullRequest,
      repository,
    };
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
  const { target, assertCurrent, projection } = deps.read;
  try {
    assertCurrent();
    const request = { ...params, ...target.params };
    let context: GitCheckoutContext | null;
    if (deps.resolveGitContext) {
      context = await deps.resolveGitContext(request);
    } else {
      const source = deps.resolveGitRoot ? await deps.resolveGitRoot(request) : target.source;
      context =
        typeof source === "string"
          ? await runGitReadOperation(
              {
                type: "checkout.context",
                input: { root: source, githubHost: deps.read.target.githubHost },
              },
              { refresh: request.refresh },
            )
          : source;
    }
    assertCurrent();
    if (!context) {
      branchCache.release(deps.cacheSignal);
      return { pullRequests: [], rateLimited: false };
    }
    // Conversation text is not evidence of session work. Only the checkout
    // selects PRs; publication receipts remain owned by the publication flow.
    if (!context.branch || context.branch === context.defaultBranch) {
      branchCache.release(deps.cacheSignal);
      return {
        pullRequests: [],
        repository: { owner: context.owner, repo: context.repo },
        rateLimited: false,
      };
    }
    const result = await cachedBranchPullRequests(
      context,
      deps,
      request.refresh === true,
      JSON.stringify([target.identity, deps.read.sourceIdentity]),
    ).catch(() => null);
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
    const branch =
      projection === "publication" || workingBranchHasLivePullRequest
        ? undefined
        : await resolveSessionBranch(
            context,
            mergedHeads,
            request.refresh === true,
            target.refreshIndex === true,
          );
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
      deps.fetchImpl ?? fetch,
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
  const transportRead = prepareSessionPullRequestGitHubRead(
    read.host,
    deps.fetchImpl ?? fetch,
    entry.access.assertCurrent,
    { signal: entry.access.signal },
  );
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
