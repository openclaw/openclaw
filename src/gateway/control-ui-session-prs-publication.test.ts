import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

const { prepareRead, load, presentation } = createSessionPullRequestsFixture();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows the bound original PR before any publication, independent of the checkout branch", async () => {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:main" },
    {
      worktree: {
        id: "imported-source",
        branch: "openclaw/task",
        repoRoot: "/synthetic/repository",
        githubPullRequest: {
          url: "https://github.com/openclaw/openclaw/pull/103469",
          host: "github.com",
          number: 103469,
          base: {
            repository: "openclaw/openclaw",
            repositoryId: 1,
            branch: "main",
            commit: "b".repeat(40),
          },
          head: {
            repository: "contributor/openclaw",
            repositoryId: 2,
            branch: "original",
            commit: "a".repeat(40),
          },
          preparedHeadCommit: "a".repeat(40),
        },
      },
    },
  );
  let original = pullListItem({
    state: "closed",
    head: {
      ref: "original",
      sha: "a".repeat(40),
      repo: { id: 2, full_name: "contributor/openclaw" },
    },
    base: {
      ref: "main",
      repo: {
        id: 1,
        name: "openclaw",
        full_name: "openclaw/openclaw",
        owner: { login: "openclaw" },
      },
    },
  });
  let responseStatus = 200;
  vi.stubGlobal(
    "fetch",
    routedFetch([
      { match: "/pulls?", response: () => githubJson([]) },
      { match: "/pulls/103469", response: () => githubJson(original, responseStatus) },
    ]),
  );
  const readOriginal = () =>
    load(
      { sessionKey: "agent:main:main", refresh: true },
      { resolveGitContext: async () => ({ ...testGitContext, branch: "openclaw/task" }) },
    );
  const result = await readOriginal();
  expect(result.pullRequests).toMatchObject([
    {
      number: 103469,
      url: "https://github.com/openclaw/openclaw/pull/103469",
      branch: "original",
      state: "closed",
    },
  ]);
  expect(result.branch).toBeUndefined();
  expect((await readOriginal()).pullRequests).toEqual(result.pullRequests);

  // Status/head observations can advance while the prepared source stays unchanged.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11_000);
  original = {
    ...original,
    merged_at: "2026-10-20T00:00:00Z",
    head: { ref: "original", sha: "c".repeat(40), repo: { id: 2 } },
  };
  expect((await readOriginal()).pullRequests).toMatchObject([
    { state: "merged", headSha: "c".repeat(40) },
  ]);

  vi.setSystemTime(Date.now() + 91_000);
  responseStatus = 502;
  expect(await readOriginal()).toMatchObject({
    pullRequests: [{ state: "merged", headSha: "c".repeat(40) }],
    status: "unavailable",
  });

  for (const change of ["inaccessible", "base repository", "head repository", "head branch"]) {
    vi.setSystemTime(Date.now() + 91_000);
    responseStatus = change === "inaccessible" ? 404 : 200;
    original = pullListItem({
      state: "closed",
      head: {
        ref: change === "head branch" ? "replaced" : "original",
        sha: "a".repeat(40),
        repo: { id: change === "head repository" ? 99 : 2 },
      },
      base: {
        ref: "main",
        repo: {
          id: change === "base repository" ? 99 : 1,
          name: "openclaw",
          owner: { login: "openclaw" },
        },
      },
    });
    expect(await readOriginal(), change).toMatchObject({
      pullRequests: [],
      discardPrevious: true,
      status: "unavailable",
    });
    vi.setSystemTime(Date.now() + 91_000);
    responseStatus = 502;
    expect(
      (await readOriginal()).pullRequests,
      "a later outage must not revive withdrawn data",
    ).toEqual([]);
  }
});

it("reads known merged heads without network access only for the same live session and physical source", async () => {
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
  vi.stubGlobal("fetch", fetchImpl);
  const sessionKey = "agent:main:known-merged-heads";
  await load({ sessionKey }, { resolveGitContext: async () => testGitContext });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const resolve = await prepareRead("connection", { sessionKey }, testGitContext);
  const resolveOther = await prepareRead(
    "connection",
    {
      sessionKey: "agent:main:other-merged-heads",
    },
    testGitContext,
  );
  const target = await resolve();
  const otherTarget = await resolveOther();
  if (!target || !otherTarget) {
    throw new Error("Missing fixture target");
  }
  const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected cache fetch"));
  vi.stubGlobal("fetch", network);
  const expected = [{ sha: head, baseRef: "main", mergeCommitSha }];
  const owner = await presentation();
  let releasedSource:
    | import("./repository-session-read.types.js").RepositorySessionSourceScope
    | undefined;
  await target.withSource(async (source) => {
    releasedSource = source;
    const known = await owner.knownMergedHeads(target);
    expect(known).toEqual(expected);
    known[0]!.sha = "d".repeat(40);
    expect(await owner.knownMergedHeads(target)).toEqual(expected);
    expect(await owner.knownMergedHeads(otherTarget)).toEqual([]);
  });
  expect(() => releasedSource!.assertCurrent()).toThrow(/source changed or closed/);

  // Identical session rows at the same path do not inherit a retired physical source's cache.
  const { readSource } = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, {
    agentId: "main",
  });
  if (!readSource) {
    throw new Error("Missing fixture source");
  }
  await closeOpenClawAgentDatabaseByPathAsync(readSource.path);
  const replacement = `${readSource.path}.replacement`;
  await fs.copyFile(readSource.path, replacement);
  await fs.rename(replacement, readSource.path);
  const reopened = await resolve();
  if (!reopened) {
    throw new Error("Missing reopened fixture target");
  }
  expect(reopened.identity).toBe(target.identity);
  expect(await owner.knownMergedHeads(reopened)).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledOnce();
});
