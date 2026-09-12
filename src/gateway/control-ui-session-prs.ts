// Detects GitHub pull requests for a session's working branch so the Control
// UI chat view can pin PR status chips above the composer.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { releaseGitReadCache, runGitReadOperation } from "../infra/git-read-cache.js";
import type {
  GitCheckoutContext,
  GitMergedPullHead as MergedPullHead,
} from "../infra/git-read-operations.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import {
  ControlUiGitHubError,
  fetchGitHubJson,
  GITHUB_API_ORIGIN,
  resolveGitHubApiCredentialScope,
} from "./control-ui-github-api.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubForkParent } from "./github-repository-target.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

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
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<BranchPullRequestsSnapshot>;
  refreshMode: "normal" | "forced" | null;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: Pick<BranchPullRequestsSnapshot, "pullRequests" | "mergedHeads" | "repository">;
};

const branchCache = createRetainedCache<CacheEntry>();

type LoadSessionPullRequestDeps = {
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

/** Resolve the recorded source before considering a Gateway workspace default. */
function resolveSessionPullRequestSource(
  params: ControlUiSessionPullRequestsParams,
): string | GitCheckoutContext | null {
  const { cfg, entry, storePath, canonicalKey } = loadGatewaySessionEntryReadOnly(
    params.sessionKey,
    {
      agentId: params.agentId,
    },
  );
  // Same session/agent scoping as sessions.files.*: a missing entry means an
  // unknown or deleted session, which must not fall back to some agent
  // workspace and surface another checkout's PRs.
  if (!entry?.sessionId || !storePath) {
    return null;
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  if (entry.repositoryWorkspaceId) {
    const repository = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
    if (!repository || repository.agentId !== agentId || repository.sessionKey !== canonicalKey) {
      return null;
    }
    const remote = parseGitHubRemoteUrl(repository.url);
    return remote ? { ...remote, branch: repository.branch } : null;
  }
  const root =
    normalizeOptionalString(entry.spawnedCwd) ??
    normalizeOptionalString(entry.spawnedWorkspaceDir) ??
    normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  if (!root) {
    return null;
  }
  return root;
}

/**
 * Resolves the GitHub repo + branch, caching detached/default/non-GitHub
 * outcomes too so repeated sidebar requests do not respawn the same probes.
 */
async function resolveSessionPullRequestGitContext(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps,
): Promise<GitCheckoutContext | null> {
  const source = deps.resolveGitRoot
    ? await deps.resolveGitRoot(params)
    : resolveSessionPullRequestSource(params);
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
function branchCreateUrl(context: GitCheckoutContext): string {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const branch = context.branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/pull/new/${branch}`;
}

async function resolveSessionBranch(
  context: GitCheckoutContext,
  mergedHeads: readonly MergedPullHead[],
  deps: LoadSessionPullRequestDeps,
  refresh: boolean,
): Promise<ControlUiSessionBranch | undefined> {
  const root = context.root;
  if (!root) {
    // Repository-only sessions have no local checkout to inspect. Their recorded
    // source still exposes publication; the broker validates the accepted checkpoint.
    return {
      owner: context.owner,
      repo: context.repo,
      branch: context.branch,
      createUrl: branchCreateUrl(context),
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
    ...(facts.creatable ? { createUrl: branchCreateUrl(context) } : {}),
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

function parsePullListItem(value: unknown): PullListItem | null {
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
  return `${GITHUB_API_ORIGIN}/repos/${encOwner}/${encRepo}/pulls?head=${encHead}&state=all&sort=updated&direction=desc&per_page=5`;
}

async function fetchParentRepo(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<{ owner: string; repo: string } | null> {
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const value = await fetchGitHubJson(url, fetchImpl, token);
  return resolveGitHubForkParent(value) ?? null;
}

// Sub-fetch degradation: quota errors abort the whole refresh (so the caller
// serves stale chips with the rate-limit flag); anything else just drops the
// optional field the sub-fetch would have filled.
function rethrowRateLimit(error: unknown): undefined {
  if (error instanceof ControlUiGitHubError && error.statusCode === 429) {
    throw error;
  }
  return undefined;
}

const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);
const CHECK_PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;
// GitHub repeats verbose application/output metadata on every run. Keep that
// budget local to checks; other JSON requests retain the shared 256 KiB cap.
const CHECK_PAGE_BYTES = 1024 * 1024;

async function fetchChecks(
  item: PullListItem,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<ControlUiSessionPullRequest["checks"]> {
  if (!item.headSha || !/^[0-9a-f]{40}$/i.test(item.headSha)) {
    return undefined;
  }
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/commits/${item.headSha}/check-runs?per_page=${CHECK_PAGE_SIZE}`;
  const counts = { passed: 0, failed: 0, skipped: 0, running: 0 };
  for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
    const value = await fetchGitHubJson(`${url}&page=${page}`, fetchImpl, token, CHECK_PAGE_BYTES);
    if (
      !isRecord(value) ||
      !Array.isArray(value.check_runs) ||
      value.check_runs.length > CHECK_PAGE_SIZE
    ) {
      return undefined;
    }
    for (const runValue of value.check_runs) {
      const run = isRecord(runValue) ? runValue : {};
      const conclusion = readNonBlankString(run.conclusion);
      // GitHub's "stale" conclusion invalidates the previous verdict.
      if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        counts.failed += 1;
      } else if (run.status !== "completed" || conclusion === "stale") {
        counts.running += 1;
      } else {
        counts[conclusion === "skipped" ? "skipped" : "passed"] += 1;
      }
    }
    const seen = counts.passed + counts.failed + counts.skipped + counts.running;
    if (seen > 0 && seen === value.total_count) {
      const state = counts.failed > 0 ? "failing" : counts.running > 0 ? "pending" : "passing";
      return { state, ...counts };
    }
    if (value.check_runs.length < CHECK_PAGE_SIZE) {
      return undefined;
    }
  }
  // An incomplete page sequence must never advertise a partial green rollup.
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
    ...(item.author ? { author: item.author } : {}),
  };
}

async function finishPullRequest(
  item: PullListItem,
  branch: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<ControlUiSessionPullRequest> {
  const chip = stateOnlyPullRequestChip(item, branch);
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const detailUrl = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/pulls/${item.number}`;
  const [details, checks] = await Promise.all([
    fetchGitHubJson(detailUrl, fetchImpl, token).catch(rethrowRateLimit),
    fetchChecks(item, fetchImpl, token).catch(rethrowRateLimit),
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
): Promise<BranchPullRequestsSnapshot> {
  const head = `${context.owner}:${context.branch}`;
  let items = parsePullList(
    await fetchGitHubJson(pullsByHeadUrl(context.owner, context.repo, head), fetchImpl, token),
  );
  if (items.length === 0) {
    // Fork flow: the branch lives on the fork but PRs open against the parent.
    const parent = await fetchParentRepo(context.owner, context.repo, fetchImpl, token);
    if (parent) {
      items = parsePullList(
        await fetchGitHubJson(pullsByHeadUrl(parent.owner, parent.repo, head), fetchImpl, token),
      );
    }
  }
  const capped = items.slice(0, MAX_PULL_REQUESTS);
  // Landing detection needs every fetched merged head, not just the displayed
  // slice: a squash-merged PR sorted past the cap still proves the tip landed.
  const mergedHeads = mergedHeadsOf(items);
  try {
    const pullRequests = await Promise.all(
      capped.map((item) => finishPullRequest(item, context.branch, fetchImpl, token)),
    );
    return { pullRequests, rateLimited: false, mergedHeads };
  } catch (error) {
    if (!(error instanceof ControlUiGitHubError && error.statusCode === 429)) {
      throw error;
    }
    // Quota ran out between the list fetch and the per-PR detail fetches:
    // keep the proven PR list as state-only chips instead of dropping it, or
    // a cold cache would show a Create PR row despite a known open PR.
    return {
      // Author and title came from the list fetch that already succeeded, so
      // they survive here; only the per-PR detail facts are missing.
      pullRequests: capped.map((item) => stateOnlyPullRequestChip(item, context.branch)),
      rateLimited: true,
      mergedHeads,
    };
  }
}

async function refreshBranchPullRequests(
  context: GitCheckoutContext,
  fetchImpl: typeof fetch,
  entry: CacheEntry,
  token: string | undefined,
): Promise<BranchPullRequestsSnapshot> {
  const repository = { owner: context.owner, repo: context.repo };
  try {
    const result = { ...(await fetchBranchPullRequests(context, fetchImpl, token)), repository };
    // Degraded state-only chips still become lastGood: a later refresh that
    // rate-limits at the list fetch must serve the proven PRs, not an empty
    // list that would resurrect the Create PR row mid-outage. The shortened
    // expiry makes the next window retry full detail.
    entry.lastGood = {
      pullRequests: result.pullRequests,
      mergedHeads: result.mergedHeads,
      repository,
    };
    if (result.rateLimited) {
      entry.expiresAt = Date.now() + RATE_LIMIT_CACHE_MS;
    }
    return result;
  } catch (error) {
    const rateLimited = error instanceof ControlUiGitHubError && error.statusCode === 429;
    entry.expiresAt = Date.now() + (rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
    if (rateLimited) {
      return {
        pullRequests: [],
        mergedHeads: [],
        ...entry.lastGood,
        repository,
        rateLimited: true,
      };
    }
    if (entry.lastGood) {
      return { ...entry.lastGood, rateLimited: false };
    }
    throw error;
  }
}

export async function loadControlUiSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps = {},
): Promise<ControlUiSessionPullRequests> {
  let context: GitCheckoutContext | null;
  try {
    context = deps.resolveGitContext
      ? await deps.resolveGitContext(params)
      : await resolveSessionPullRequestGitContext(params, deps);
  } catch (error) {
    releaseSessionPullRequestLocalGitCache(deps.cacheSignal);
    branchCache.release(deps.cacheSignal);
    throw error;
  }
  if (!context) {
    releaseGitReadCache("pull-request.branch-facts", deps.cacheSignal);
    branchCache.release(deps.cacheSignal);
    return { pullRequests: [], rateLimited: false };
  }
  if (context.branch === context.defaultBranch) {
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
  const result = await cachedBranchPullRequests(context, deps, params.refresh === true).catch(
    () => {
      releaseGitReadCache("pull-request.branch-facts", deps.cacheSignal);
      return null;
    },
  );
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
  const { mergedHeads, ...snapshot } = result;
  const branch = await resolveSessionBranch(context, mergedHeads, deps, params.refresh === true);
  return branch ? { ...snapshot, branch } : snapshot;
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
): Promise<BranchPullRequestsSnapshot> {
  let identity: ReturnType<typeof resolveGitHubApiCredentialScope>;
  try {
    identity = resolveGitHubApiCredentialScope();
  } catch (error) {
    branchCache.release(deps.cacheSignal);
    throw error;
  }
  const { token, cacheScope } = identity;
  const key = `${context.owner.toLowerCase()}/${context.repo.toLowerCase()}#${context.branch}\0${cacheScope}`;
  const cached = branchCache.get(key, deps.cacheSignal);
  if (cached && cached.expiresAt > Date.now()) {
    branchCache.set(key, cached, deps.cacheSignal);
    if (!refresh || cached.refreshMode === "forced") {
      return cached.promise;
    }
    const pendingSnapshot = cached.promise;
    const pendingRefreshMode = cached.refreshMode;
    const pendingExpiresAt = cached.expiresAt;
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
      return refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, cached, token);
    });
  }
  const entry: CacheEntry = cached ?? {
    expiresAt: 0,
    promise: Promise.resolve({ pullRequests: [], rateLimited: false, mergedHeads: [] }),
    refreshMode: null,
  };
  const promise = trackBranchRefresh(entry, refresh ? "forced" : "normal", () =>
    refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, entry, token),
  );
  branchCache.set(key, entry, deps.cacheSignal);
  return promise;
}
