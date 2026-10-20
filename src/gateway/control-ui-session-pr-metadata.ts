import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import { gitHubPublicApi } from "./github-public-api.js";

type Read = ReturnType<typeof prepareSessionPullRequestGitHubRead>;
type Entry = {
  access: ReturnType<typeof createGitHubReadGroup>;
  expiresAt: number;
  startedAt: number;
  failed?: boolean;
  promise?: Promise<ControlUiSessionPullRequest>;
  lastGood?: ControlUiSessionPullRequest;
};
const metadata = createRetainedCache<Entry>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    metadata.clear();
  }
});

/** One GitHub metadata read per credential/repository/number, across task and branch views. */
export async function readSessionPullRequestMetadata(
  target: Pick<ControlUiSessionPullRequest, "owner" | "repo" | "number">,
  read: Read,
  load: (read: Read) => Promise<ControlUiSessionPullRequest>,
  options: {
    refresh?: boolean;
    signal?: AbortSignal;
    expected?: string;
    retainFailure?: boolean;
    onRetainedFailure?: () => void;
  } = {},
): Promise<ControlUiSessionPullRequest> {
  read.assertCurrent();
  const key = JSON.stringify([
    read.host,
    read.apiBaseUrl,
    read.cacheScope,
    target.owner.toLowerCase(),
    target.repo.toLowerCase(),
    target.number,
  ]);
  let entry = metadata.get(key);
  const now = Date.now();
  const matches =
    !options.expected ||
    !entry?.lastGood ||
    pullRequestMetadataSignature(entry.lastGood) === options.expected;
  const reusable =
    entry &&
    !entry.access.signal.aborted &&
    entry.startedAt <= now &&
    entry.expiresAt > now &&
    (entry.failed || matches) &&
    (entry.failed || !options.refresh || entry.startedAt + 10_000 > now);
  if (!entry || entry.access.signal.aborted) {
    entry = { access: createGitHubReadGroup(), expiresAt: 0, startedAt: 0 };
  }
  const active = entry;
  const release = active.access.add(read.assertCurrent, options.signal);
  try {
    if (!reusable || !active.promise) {
      const transport = prepareSessionPullRequestGitHubRead(
        read.host,
        active.access.assertCurrent,
        { signal: active.access.signal },
      );
      active.startedAt = now;
      active.failed = false;
      active.expiresAt = now + 90_000;
      active.promise = load(transport).then(
        (result) => {
          active.lastGood = result;
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
      if (options.retainFailure && active.lastGood) {
        options.onRetainedFailure?.();
        return active.lastGood;
      }
      throw error;
    }
  } finally {
    release();
    read.assertCurrent();
  }
}

export function pullRequestMetadataSignature(
  pull: Pick<ControlUiSessionPullRequest, "state" | "title" | "headSha">,
) {
  return JSON.stringify([pull.state, pull.title, pull.headSha]);
}
