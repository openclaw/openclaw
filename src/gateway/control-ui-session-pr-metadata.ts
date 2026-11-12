import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
  ControlUiSessionTaskPullRequest,
} from "./control-ui-contract.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import {
  fetchSessionPullRequestCheckRollup,
  sessionPullRequestRepositoryApiUrl,
} from "./control-ui-session-prs-checks.js";
import { gitHubPublicApi } from "./github-public-api.js";

type Read = ReturnType<typeof prepareSessionPullRequestGitHubRead>;
type Entry = {
  access: ReturnType<typeof createGitHubReadGroup>;
  expiresAt: number;
  startedAt: number;
  failed?: boolean;
  signature?: string;
  promise?: Promise<ControlUiSessionPullRequest>;
  lastGood?: ControlUiSessionPullRequest;
};
const metadata = createRetainedCache<Entry>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    metadata.clear();
  }
});

function metadataKey(
  target: Pick<ControlUiSessionPullRequest, "owner" | "repo" | "number">,
  read: Pick<Read, "host" | "apiBaseUrl" | "cacheScope">,
  bindingIdentity?: string,
) {
  return JSON.stringify([
    read.host,
    read.apiBaseUrl,
    read.cacheScope,
    target.owner.toLowerCase(),
    target.repo.toLowerCase(),
    target.number,
    bindingIdentity,
  ]);
}

/**
 * Passive rows reuse state chips an active viewer already verified; they never start a lookup.
 * One credential scope per host and state-chip fields only keep sidebar pushes small.
 */
export function withCachedPullRequestStates(
  tasks: readonly ControlUiSessionTaskPullRequest[],
  read: { target: { githubHost?: string }; assertCurrent: () => void },
): ControlUiSessionTaskPullRequest[] {
  const reads = new Map<string, Read | null>();
  const readFor = (host: string) => {
    if (!reads.has(host)) {
      try {
        const supported = host === "github.com" || host === read.target.githubHost;
        reads.set(
          host,
          supported ? prepareSessionPullRequestGitHubRead(host, read.assertCurrent) : null,
        );
      } catch {
        reads.set(host, null);
      }
    }
    return reads.get(host);
  };
  return tasks.map((known) => {
    const scope = readFor(new URL(known.url).hostname);
    const entry = scope ? metadata.get(metadataKey(known, scope)) : undefined;
    const cached = entry?.access.signal.aborted ? undefined : entry?.lastGood;
    if (!cached) {
      return known;
    }
    const { owner, repo, number, branch, title, url, state } = cached;
    return { ...known, pullRequest: { owner, repo, number, branch, title, url, state } };
  });
}

/** One GitHub metadata read per credential/repository/number, across task and branch views. */
export async function readSessionPullRequestMetadata(
  target: Pick<ControlUiSessionPullRequest, "owner" | "repo" | "number">,
  read: Read,
  load: (read: Read) => Promise<ControlUiSessionPullRequest>,
  options: {
    refresh?: boolean;
    /** A bound workspace must not reuse metadata admitted for another association. */
    bindingIdentity?: string;
    signal?: AbortSignal;
    expected?: string;
    retainFailure?: (error: unknown) => boolean;
    onRetainedFailure?: (error: unknown) => void;
  } = {},
): Promise<ControlUiSessionPullRequest> {
  read.assertCurrent();
  const key = metadataKey(target, read, options.bindingIdentity);
  let entry = metadata.get(key);
  const now = Date.now();
  const matches = !options.expected || entry?.signature === options.expected;
  const reusable =
    entry &&
    !entry.access.signal.aborted &&
    entry.startedAt <= now &&
    entry.expiresAt > now &&
    (entry.failed || matches) &&
    (entry.failed || !options.refresh || entry.startedAt + 10_000 > now);
  if (!entry || !reusable) {
    // Pending metadata belongs to its prepared observation; older completions retain their own entry.
    entry = {
      access: createGitHubReadGroup(),
      expiresAt: 0,
      startedAt: 0,
      signature: options.expected,
      lastGood: entry?.access.signal.aborted ? undefined : entry?.lastGood,
    };
  }
  const active = entry;
  const release = active.access.add(read.assertCurrent, options.signal);
  try {
    if (!reusable || !active.promise) {
      const transport = prepareSessionPullRequestGitHubRead(
        read.host,
        active.access.assertCurrent,
        { signal: active.access.signal, credential: read.credential },
      );
      active.startedAt = now;
      active.failed = false;
      active.expiresAt = now + 90_000;
      active.promise = load(transport).then(
        (result) => {
          active.lastGood = result;
          active.signature = pullRequestMetadataSignature(result);
          return result;
        },
        (error: unknown) => {
          active.failed = true;
          active.expiresAt =
            Date.now() +
            (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429
              ? 300_000
              : 30_000);
          throw error;
        },
      );
      metadata.set(key, active);
    }
    try {
      return await racePromiseWithAbortSignal(active.promise, options.signal);
    } catch (error) {
      read.assertCurrent();
      const retain = options.retainFailure?.(error);
      if (retain && active.lastGood) {
        options.onRetainedFailure?.(error);
        return active.lastGood;
      }
      if (retain === false) {
        active.lastGood = undefined;
      }
      throw error;
    }
  } finally {
    release();
    read.assertCurrent();
  }
}

function pullRequestMetadataSignature(
  pull: Pick<ControlUiSessionPullRequest, "state" | "title" | "headSha">,
) {
  return JSON.stringify([pull.state, pull.title, pull.headSha]);
}

/** Display enrichment retains matching prior details when quota ends after a proven list read. */
export async function readSessionPullRequestDisplay(
  pullRequests: readonly ControlUiSessionPullRequest[],
  read: Read,
  options: {
    refresh: boolean;
    previous?: readonly ControlUiSessionPullRequest[];
    limit: number;
  },
): Promise<Pick<ControlUiSessionPullRequests, "pullRequests" | "rateLimited">> {
  try {
    return {
      pullRequests: await Promise.all(
        pullRequests.map((item) =>
          readSessionPullRequestMetadata(
            item,
            read,
            (transport) => finishPullRequest(item, item.branch, transport),
            { refresh: options.refresh, expected: pullRequestMetadataSignature(item) },
          ),
        ),
      ),
      rateLimited: false,
    };
  } catch (error) {
    read.assertCurrent();
    if (!(error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429)) {
      throw error;
    }
    const identity = (item: ControlUiSessionPullRequest) =>
      `${item.owner}/${item.repo}#${item.number}`.toLowerCase();
    const retained = new Map(options.previous?.map((item) => [identity(item), item]));
    const fresh = pullRequests.map((item) => {
      const prior = retained.get(identity(item));
      retained.delete(identity(item));
      return prior &&
        item.state === prior.state &&
        item.headSha === prior.headSha &&
        (item.state === "open" || item.state === "draft")
        ? { ...prior, ...item }
        : item;
    });
    return {
      pullRequests: [...fresh, ...retained.values()].slice(0, options.limit),
      rateLimited: true,
    };
  }
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

export function parsePullListItem(value: unknown) {
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
  const headRepo = isRecord(head.repo) ? head.repo : {};
  const headRepository = readNonBlankString(headRepo.full_name);
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
    ...(headRepository ? { headRepository } : {}),
    baseRef: readNonBlankString(base.ref),
    mergeCommitSha: readNonBlankString(value.merge_commit_sha),
  };
}

type PullRequestChipInput = Pick<
  ControlUiSessionPullRequest,
  "number" | "author" | "owner" | "repo" | "title" | "url" | "state" | "headSha"
>;

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
export function stateOnlyPullRequestChip(
  item: PullRequestChipInput,
  branch: string,
): ControlUiSessionPullRequest {
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

export async function finishPullRequest(
  item: PullRequestChipInput,
  branch: string,
  read: ReturnType<typeof prepareSessionPullRequestGitHubRead>,
  preparedDetails?: unknown,
): Promise<ControlUiSessionPullRequest> {
  const chip = stateOnlyPullRequestChip(item, branch);
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const detailUrl = `${sessionPullRequestRepositoryApiUrl({ ...item, apiBaseUrl: read.apiBaseUrl })}/pulls/${item.number}`;
  const [details, checks] = await Promise.all([
    preparedDetails === undefined
      ? read.request(detailUrl).catch(rethrowRateLimit)
      : Promise.resolve(preparedDetails),
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

/** Read the accepted original identity, without treating its observed commit as a head lock. */
export async function loadBoundSessionPullRequest(
  binding: SessionGitHubPullRequestBinding,
  read: Read,
  options: {
    bindingIdentity: string;
    refresh?: boolean;
    signal?: AbortSignal;
    onRetainedFailure: (error: unknown) => void;
    preparedDetails?: unknown;
  },
): Promise<ControlUiSessionPullRequest> {
  const [owner, repo] = binding.base.repository.split("/");
  if (
    !owner ||
    !repo ||
    binding.url !== `https://${read.host}/${owner}/${repo}/pull/${binding.number}`
  ) {
    throw new Error("The session pull request association changed");
  }
  const preparedItem = parsePullListItem(options.preparedDetails);
  return readSessionPullRequestMetadata(
    { owner, repo, number: binding.number },
    read,
    async (transport) => {
      const details =
        options.preparedDetails ??
        (await transport.request(
          `${sessionPullRequestRepositoryApiUrl({ owner, repo, apiBaseUrl: transport.apiBaseUrl })}/pulls/${binding.number}`,
        ));
      const item = parsePullListItem(details);
      const base = isRecord(details) && isRecord(details.base) ? details.base : undefined;
      const head = isRecord(details) && isRecord(details.head) ? details.head : undefined;
      if (
        !item ||
        item.url !== binding.url ||
        item.number !== binding.number ||
        item.owner.toLowerCase() !== owner.toLowerCase() ||
        item.repo.toLowerCase() !== repo.toLowerCase() ||
        !base ||
        !isRecord(base.repo) ||
        base.repo.id !== binding.base.repositoryId ||
        !head ||
        head.ref !== binding.head.branch ||
        (head.repo !== null && (!isRecord(head.repo) || head.repo.id !== binding.head.repositoryId))
      ) {
        throw new Error("The session pull request association changed");
      }
      try {
        return await finishPullRequest(item, binding.head.branch, transport, details);
      } catch (error) {
        // The identity is verified; quota exhaustion only withholds counts and checks.
        if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429) {
          options.onRetainedFailure(error);
          return stateOnlyPullRequestChip(item, binding.head.branch);
        }
        throw error;
      }
    },
    {
      ...options,
      ...(preparedItem
        ? {
            expected: pullRequestMetadataSignature(
              stateOnlyPullRequestChip(preparedItem, binding.head.branch),
            ),
          }
        : {}),
      retainFailure: (error) =>
        error instanceof gitHubPublicApi.ControlUiGitHubError &&
        (error.retryable || error.statusCode === 502),
    },
  );
}
