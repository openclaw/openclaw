import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPrReadContext } from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";
import {
  loadControlUiSessionPullRequests,
  readKnownSessionBranchMergedHeads,
} from "./control-ui-session-prs.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { isGitHubPublicationSuperseded } from "./github-publication-relevance.js";

const { prepareRead, load } = createSessionPullRequestsFixture();
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
    apiBaseUrl: "https://api.github.com",
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

it("reads known merged heads without network access only for the same live session, source and credential", async () => {
  let cacheScope = "known-merged-heads";
  vi.spyOn(gitHubPublicApi, "resolveGitHubApiCredentialScope").mockImplementation(() => ({
    token: undefined,
    cacheScope,
    apiBaseUrl: "https://api.github.com",
  }));
  const head = "a".repeat(40);
  const mergeCommitSha = "b".repeat(40);
  const fetchImpl = routedFetch([
    {
      match: "/pulls?head=",
      response: () =>
        githubJson([
          pullListItem({
            state: "closed",
            merged_at: "2026-07-01T00:00:00Z",
            head: { sha: head },
            merge_commit_sha: mergeCommitSha,
          }),
          pullListItem({ number: 103470, state: "closed", head: { sha: "c".repeat(40) } }),
        ]),
    },
  ]);
  const sessionKey = "agent:main:known-merged-heads";
  await load({ sessionKey }, { fetchImpl, resolveGitContext: async () => testGitContext });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const resolve = await prepareRead("connection", { sessionKey });
  const resolveOther = await prepareRead("connection", {
    sessionKey: "agent:main:other-merged-heads",
  });
  const target = await resolve();
  const otherTarget = await resolveOther();
  if (!target || !otherTarget) {
    throw new Error("Missing fixture target");
  }
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected cache fetch"));
  const expected = [{ sha: head, baseRef: "main", mergeCommitSha }];
  let releasedRead: ControlUiSessionPrReadContext | undefined;
  await withControlUiSessionPrSource(target.readSource, async (assertCurrent, sourceIdentity) => {
    const read = { target, sourceIdentity, assertCurrent };
    releasedRead = read;
    const known = readKnownSessionBranchMergedHeads(testGitContext, read);
    expect(known).toEqual(expected);
    known[0]!.sha = "d".repeat(40);
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual(expected);
    expect(
      readKnownSessionBranchMergedHeads(testGitContext, { ...read, target: otherTarget }),
    ).toEqual([]);
    expect(
      readKnownSessionBranchMergedHeads({ ...testGitContext, branch: "other-branch" }, read),
    ).toEqual([]);
    cacheScope = "replacement-credential";
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual([]);
    cacheScope = "known-merged-heads";
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual(expected);
  });
  expect(() => readKnownSessionBranchMergedHeads(testGitContext, releasedRead!)).toThrow(
    /source changed or closed/,
  );

  // Identical session rows at the same path do not inherit a retired physical source's cache.
  await closeOpenClawAgentDatabaseByPathAsync(target.readSource.path);
  const replacement = `${target.readSource.path}.replacement`;
  await fs.copyFile(target.readSource.path, replacement);
  await fs.rename(replacement, target.readSource.path);
  const reopened = await resolve();
  if (!reopened) {
    throw new Error("Missing reopened fixture target");
  }
  expect(reopened.identity).toBe(target.identity);
  await withControlUiSessionPrSource(reopened.readSource, async (assertCurrent, sourceIdentity) => {
    expect(
      readKnownSessionBranchMergedHeads(testGitContext, {
        target: reopened,
        sourceIdentity,
        assertCurrent,
      }),
    ).toEqual([]);
  });
  expect(network).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledOnce();
});
