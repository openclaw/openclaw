import { afterEach, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { isGitHubPublicationSuperseded } from "./github-publication-relevance.js";

const { prepareRead } = createSessionPullRequestsFixture();
let owner: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;
afterEach(async () => {
  await owner?.stop();
  owner = undefined;
  vi.restoreAllMocks();
});

it("reconciles a fourth merged PR without expanding or poisoning displayed PRs", async () => {
  const head = "a".repeat(40);
  const tree = "b".repeat(40);
  vi.spyOn(gitHubPublicApi, "resolveGitHubApiCredentialScope").mockReturnValue({
    token: undefined,
    cacheScope: "fixture",
  });
  const items = [5, 4, 3].map((number) => pullListItem({ number, state: "closed" }));
  items.push(
    pullListItem({
      number: 2,
      state: "closed",
      merged_at: "2026-07-01T00:00:00Z",
      head: { sha: head },
    }),
  );
  const fetchImpl = routedFetch([
    { match: "/pulls?head=", response: () => githubJson(items) },
    {
      match: "/git/commits/" + head,
      response: () => githubJson({ sha: head, tree: { sha: tree } }),
    },
  ]);
  const broadcastToConnIds = vi.fn();
  owner = createTestControlUiSessionPrSubscriptions({
    scheduler: createTestGatewayScheduler(),
    broadcastToConnIds,
    load: (params, cacheSignal, read) =>
      loadControlUiSessionPullRequests(params, {
        cacheSignal,
        read,
        fetchImpl,
        resolveGitContext: async () => testGitContext,
      }),
  });
  const resolve = await prepareRead("connection", { sessionKey: "agent:main:main" });
  const target = await resolve();
  if (!target) {
    throw new Error("Missing fixture target");
  }
  const current = () => {};
  const displayed = await owner.read(target, current);
  expect(displayed.pullRequests.map((pr) => pr.number)).toEqual([5, 4, 3]);
  const candidates = await owner.read(target, current, "publication");
  expect(candidates.pullRequests.map((pr) => pr.number)).toEqual([5, 4, 3, 2]);
  const snapshot = {
    repository: "openclaw/openclaw",
    branch: testGitContext.branch,
    source_head_commit: head,
    workspace_tree: tree,
  };
  expect(
    await isGitHubPublicationSuperseded(snapshot, candidates.pullRequests, {
      fetchImpl,
      assertCurrent: current,
    }),
  ).toBe(true);
  expect(
    await isGitHubPublicationSuperseded(
      { ...snapshot, workspace_tree: "c".repeat(40) },
      candidates.pullRequests,
      { fetchImpl, assertCurrent: current },
    ),
  ).toBe(false);
  expect((await owner.read(target, current)).pullRequests).toEqual(displayed.pullRequests);
  expect(displayed).not.toHaveProperty("publicationCandidates");
  expect(candidates).not.toHaveProperty("publicationCandidates");
  expect(
    fetchImpl.mock.calls.filter(([url]) => typeof url === "string" && url.includes("/pulls?head=")),
  ).toHaveLength(1);
  expect(broadcastToConnIds).not.toHaveBeenCalled();
});
