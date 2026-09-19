import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import {
  evictPullRequestCache,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
  await evictPullRequestCache();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("marks retained PR data unavailable after a refresh fails, then recovers", async () => {
  let failed = false;
  const fetchImpl = routedFetch([
    {
      match: "/pulls?head=",
      response: () =>
        failed
          ? githubJson({ message: "Unavailable" }, 503)
          : githubJson([pullListItem({ state: "closed", merged_at: "2026-09-01T00:00:00Z" })]),
    },
  ]);
  const load = () =>
    loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:stale-preview" },
      {
        fetchImpl,
        resolveGitContext: async () => ({ ...testGitContext, branch: "stale-preview" }),
      },
    );
  const fresh = await load();
  expect(fresh.pullRequests[0]?.state).toBe("merged");
  failed = true;
  vi.advanceTimersByTime(91_000);
  const stale = await load();
  expect(stale.pullRequests).toEqual(fresh.pullRequests);
  expect(stale.status).toBe("unavailable");
  expect(stale.rateLimited).toBe(false);
  const calls = fetchImpl.mock.calls.length;
  expect(await load()).toEqual(stale);
  expect(fetchImpl.mock.calls).toHaveLength(calls);
  failed = false;
  vi.advanceTimersByTime(31_000);
  const recovered = await load();
  expect(recovered.status).not.toBe("unavailable");
  expect(recovered.pullRequests).toEqual(fresh.pullRequests);
});
