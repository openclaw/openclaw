import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { releaseGitReadCache, runGitReadOperation } from "../infra/git-read-cache.js";
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
  loadSessionPullRequestReferences,
  releaseSessionPullRequestReferenceCache,
} from "./control-ui-session-pr-references.js";
import { fetchSessionPullRequestCheckRollup } from "./control-ui-session-prs-checks.js";
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
  mergedHeads: MergedPullHead[];
  workingBranchHasLivePullRequest: boolean;
  referencesIncomplete?: boolean;
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<BranchPullRequestsSnapshot>;
  refreshMode: "normal" | "forced" | null;
  references: readonly number[];
  referenceSignature: string;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: Pick<
    BranchPullRequestsSnapshot,
    "pullRequests" | "mergedHeads" | "repository" | "workingBranchHasLivePullRequest"
  >;
};

const branchCache = createRetainedCache<CacheEntry>();

type LoadSessionPullRequestDeps = {
  read: ControlUiSessionPrReadContext;
  cacheSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveGitRoot?: (params: ControlUiSessionPullRequestsParams) => Promise<string | null>;
  resolveGitContext?: (
    params: ControlUiSessionPullRequestsParams,
  ) => Promise<GitCheckoutContext | null>;
};

function releaseSessionPullRequestLocalGitCache(signal?: AbortSignal): void {
  releaseGitReadCache("checkout.context", signal);
  releaseGitReadCache("pull-request.branch-facts", signal);
}

/**
 * Resolves the GitHub repo + branch, caching detached/default/non-GitHub
 * outcomes too so repeated sidebar requests do not respawn the same probes.
 */
async function resolveSessionPullRequestGitContext(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps,
  capturedSource: string | GitCheckoutContext | null,
): Promise<GitCheckoutContext | null> {
  const source = deps.resolveGitRoot ? await deps.resolveGitRoot(params) : capturedSource;
  if (typeof source !== "string") {
    releaseSessionPullRequestLocalGitCache(deps.cacheSignal);
    return source;
  }
  return runGitReadOperation(
    { type: "checkout.context", input: { root: source } },
    { refresh: params.refresh === true, cacheSignal: deps.cacheSignal },
  );
}

// git push's own "create a pull request" hint URL; GitHub resolves the base
// branch (including fork -> parent) so no API call is needed to build it.
function branchCreateUrl(context: GitCheckoutContext, branchName: string): string {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const branch = branchName.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/pull/new/${branch}`;
}

async function resolveSessionBranch(
  context: GitCheckoutContext,
  mergedHeads: readonly MergedPullHead[],
  deps: LoadSessionPullRequestDeps,
  refresh: boolean,
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
      input: { root, branch: context.branch, defaultBranch: context.defaultBranch, mergedHeads },
    },
    { refresh, cacheSignal: deps.cacheSignal },
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

function parsePullList(value: unknown): PullListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parsePullListItem).filter((item): item is PullListItem => item !== null);
}

function pullsByHeadUrl(owner: string, repo: string, head: string): string {
  const encOwner = encodeURIComponent(owner);
  const encRepo = encodeURIComponent(repo);
  const encHead = encodeURIComponent(head);
  return `${gitHubPublicApi.GITHUB_API_ORIGIN}/repos/${encOwner}/${encRepo}/pulls?head=${encHead}&state=all&sort=updated&direction=desc&per_page=5`;
}

async function fetchParentRepo(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<{ owner: string; repo: string } | null> {
  const url = `${gitHubPublicApi.GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const value = await gitHubPublicApi.fetchGitHubJson(url, fetchImpl, token);
  return resolveGitHubForkParent(value) ?? null;
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
  fetchImpl: typeof fetch,
  token: string | undefined,
  knownDetails?: Record<string, unknown>,
): Promise<ControlUiSessionPullRequest> {
  const chip = stateOnlyPullRequestChip(item, branch);
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const detailUrl = `${gitHubPublicApi.GITHUB_API_ORIGIN}/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/pulls/${item.number}`;
  const [details, checks] = await Promise.all([
    knownDetails ??
      gitHubPublicApi.fetchGitHubJson(detailUrl, fetchImpl, token).catch(rethrowRateLimit),
    fetchSessionPullRequestCheckRollup(item, fetchImpl, token).catch(rethrowRateLimit),
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
  fetchImpl: typeof fetch,
  token: string | undefined,
  references: readonly number[],
): Promise<BranchPullRequestsSnapshot> {
  const head = `${context.owner}:${context.branch}`;
  const hasWorkingBranch = Boolean(context.branch && context.branch !== context.defaultBranch);
  let items = hasWorkingBranch
    ? parsePullList(
        await gitHubPublicApi.fetchGitHubJson(
          pullsByHeadUrl(context.owner, context.repo, head),
          fetchImpl,
          token,
        ),
      )
    : [];
  if (hasWorkingBranch && items.length === 0) {
    // Fork flow: the branch lives on the fork but PRs open against the parent.
    const parent = await fetchParentRepo(context.owner, context.repo, fetchImpl, token);
    if (parent) {
      items = parsePullList(
        await gitHubPublicApi.fetchGitHubJson(
          pullsByHeadUrl(parent.owner, parent.repo, head),
          fetchImpl,
          token,
        ),
      );
    }
  }
  // Landing detection needs every fetched merged head, not just the displayed
  // slice: a squash-merged PR sorted past the cap still proves the tip landed.
  // Referenced PRs may belong to another branch and never prove this checkout landed.
  const mergedHeads = mergedHeadsOf(items);
  const workingBranchHasLivePullRequest = items.some(
    (item) => item.state === "open" || item.state === "draft",
  );
  const knownDetails = new Map<PullListItem, Record<string, unknown>>();
  const referenced: PullListItem[] = [];
  let rateLimited = false;
  let referencesIncomplete = false;
  for (const number of references) {
    const existing = items.find(
      (item) =>
        item.number === number &&
        item.owner.toLowerCase() === context.owner.toLowerCase() &&
        item.repo.toLowerCase() === context.repo.toLowerCase(),
    );
    if (existing) {
      referenced.push(existing);
      continue;
    }
    const url = `${gitHubPublicApi.GITHUB_API_ORIGIN}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/pulls/${number}`;
    let details: unknown;
    try {
      details = await gitHubPublicApi.fetchGitHubJson(url, fetchImpl, token);
    } catch (error) {
      if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 404) {
        continue;
      }
      if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429) {
        rateLimited = true;
        break;
      }
      if (items.length > 0 || referenced.length > 0) {
        referencesIncomplete = true;
        break;
      }
      throw error;
    }
    const item = parsePullListItem(details);
    if (item?.branch && isRecord(details)) {
      referenced.push(item);
      knownDetails.set(item, details);
    }
  }
  const isActive = (item: PullListItem) => item.state === "open" || item.state === "draft";
  // A referenced PR cannot displace the working branch's live PR and offer duplicate publication.
  const candidates = [...new Set([...items.filter(isActive), ...referenced, ...items])];
  const capped = candidates
    .toSorted((left, right) => Number(isActive(right)) - Number(isActive(left)))
    .slice(0, MAX_PULL_REQUESTS);
  const branchOf = (item: PullListItem) => item.branch ?? context.branch ?? "";
  const stateOnlySnapshot = () => ({
    pullRequests: capped.map((item) => stateOnlyPullRequestChip(item, branchOf(item))),
    rateLimited: true,
    mergedHeads,
    workingBranchHasLivePullRequest,
  });
  if (rateLimited) {
    return stateOnlySnapshot();
  }
  try {
    const pullRequests = await Promise.all(
      capped.map((item) =>
        finishPullRequest(item, branchOf(item), fetchImpl, token, knownDetails.get(item)),
      ),
    );
    return {
      pullRequests,
      rateLimited: false,
      mergedHeads,
      workingBranchHasLivePullRequest,
      referencesIncomplete,
    };
  } catch (error) {
    if (!(error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429)) {
      throw error;
    }
    // Quota ran out between the list fetch and the per-PR detail fetches:
    // keep the proven PR list as state-only chips instead of dropping it, or
    // a cold cache would show a Create PR row despite a known open PR.
    return stateOnlySnapshot();
  }
}

async function refreshBranchPullRequests(
  context: GitCheckoutContext,
  fetchImpl: typeof fetch,
  entry: CacheEntry,
  token: string | undefined,
  references: readonly number[],
): Promise<BranchPullRequestsSnapshot> {
  const repository = { owner: context.owner, repo: context.repo };
  try {
    const result = {
      ...(await fetchBranchPullRequests(context, fetchImpl, token, references)),
      repository,
    };
    if (result.rateLimited || result.referencesIncomplete) {
      entry.expiresAt = Date.now() + (result.rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
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
      mergedHeads: result.mergedHeads,
      workingBranchHasLivePullRequest: result.workingBranchHasLivePullRequest,
      repository,
    };
    return result;
  } catch (error) {
    const rateLimited =
      error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429;
    entry.expiresAt = Date.now() + (rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
    if (rateLimited) {
      return {
        pullRequests: [],
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
  const { target, assertCurrent } = deps.read;
  try {
    assertCurrent();
    const request = { ...params, ...target.params };
    const context = deps.resolveGitContext
      ? await deps.resolveGitContext(request)
      : await resolveSessionPullRequestGitContext(request, deps, target.source);
    assertCurrent();
    if (!context) {
      releaseGitReadCache("pull-request.branch-facts", deps.cacheSignal);
      branchCache.release(deps.cacheSignal);
      releaseSessionPullRequestReferenceCache(deps.cacheSignal);
      return { pullRequests: [], rateLimited: false };
    }
    let referencesUnavailable = false;
    const references = await loadSessionPullRequestReferences(
      request,
      context,
      deps.cacheSignal,
    ).catch(() => {
      referencesUnavailable = true;
      return undefined;
    });
    assertCurrent();
    if ((!context.branch || context.branch === context.defaultBranch) && references?.length === 0) {
      releaseGitReadCache("pull-request.branch-facts", deps.cacheSignal);
      branchCache.release(deps.cacheSignal);
      return {
        pullRequests: [],
        repository: { owner: context.owner, repo: context.repo },
        rateLimited: false,
      };
    }
    // Normal polling reuses local Git facts across a poll cycle; forced
    // structural refreshes observe the replacement checkout immediately.
    const result = await cachedBranchPullRequests(
      context,
      deps,
      request.refresh === true,
      references,
      JSON.stringify([target.identity, deps.read.sourceIdentity]),
    ).catch(() => {
      releaseGitReadCache("pull-request.branch-facts", deps.cacheSignal);
      return null;
    });
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
    const { mergedHeads, workingBranchHasLivePullRequest, referencesIncomplete, ...snapshot } =
      result;
    const branch = workingBranchHasLivePullRequest
      ? undefined
      : await resolveSessionBranch(context, mergedHeads, deps, request.refresh === true);
    assertCurrent();
    return {
      ...snapshot,
      ...(branch ? { branch } : {}),
      ...(referencesIncomplete ||
      (referencesUnavailable &&
        (!context.branch || context.branch === context.defaultBranch) &&
        snapshot.pullRequests.length === 0)
        ? { status: "unavailable" as const }
        : {}),
    };
  } catch (error) {
    releaseSessionPullRequestLocalGitCache(deps.cacheSignal);
    branchCache.release(deps.cacheSignal);
    releaseSessionPullRequestReferenceCache(deps.cacheSignal);
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
  requestedReferences: readonly number[] | undefined,
  sessionIdentity: string,
): Promise<BranchPullRequestsSnapshot> {
  let identity: ReturnType<typeof gitHubPublicApi.resolveGitHubApiCredentialScope>;
  try {
    identity = gitHubPublicApi.resolveGitHubApiCredentialScope();
  } catch (error) {
    branchCache.release(deps.cacheSignal);
    throw error;
  }
  const { token, cacheScope } = identity;
  // References belong to the conversation generation. Updating its reference list must
  // retain the branch's proven PR state and quota backoff, without sharing another task's links.
  const key = JSON.stringify([
    context.owner.toLowerCase(),
    context.repo.toLowerCase(),
    context.branch,
    sessionIdentity,
    cacheScope,
  ]);
  const cached = branchCache.get(key, deps.cacheSignal);
  const references = requestedReferences ?? cached?.references ?? [];
  const referenceSignature = references.join(",");
  const referencesChanged =
    cached !== undefined && cached.referenceSignature !== referenceSignature;
  const forceRefresh = refresh || referencesChanged;
  if (cached && cached.expiresAt > Date.now()) {
    branchCache.set(key, cached, deps.cacheSignal);
    if (!forceRefresh || (cached.refreshMode === "forced" && !referencesChanged)) {
      return cached.promise;
    }
    const pendingSnapshot = cached.promise;
    const pendingRefreshMode = cached.refreshMode;
    const pendingExpiresAt = cached.expiresAt;
    cached.references = references;
    cached.referenceSignature = referenceSignature;
    return trackBranchRefresh(cached, "forced", async () => {
      const snapshot = await pendingSnapshot;
      // GitHub quota backoff stays authoritative even when a PR announcement
      // queues this lookup behind an older normal or settled request.
      if (snapshot.rateLimited) {
        if (pendingRefreshMode === null) {
          cached.expiresAt = pendingExpiresAt;
        }
        return snapshot;
      }
      return refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, cached, token, references);
    });
  }
  const entry: CacheEntry = cached ?? {
    expiresAt: 0,
    promise: Promise.resolve({
      pullRequests: [],
      rateLimited: false,
      mergedHeads: [],
      workingBranchHasLivePullRequest: false,
    }),
    refreshMode: null,
    references,
    referenceSignature,
  };
  entry.references = references;
  entry.referenceSignature = referenceSignature;
  const promise = trackBranchRefresh(entry, forceRefresh ? "forced" : "normal", () =>
    refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, entry, token, references),
  );
  branchCache.set(key, entry, deps.cacheSignal);
  return promise;
}
