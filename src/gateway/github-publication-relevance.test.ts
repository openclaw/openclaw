import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { isGitHubPublicationSuperseded } from "./github-publication-relevance.js";

const source = "1".repeat(40);
const tree = "2".repeat(40);
const head = "3".repeat(40);
const snapshot = {
  repository: "owner/repo",
  branch: "feature",
  source_head_commit: source,
  workspace_tree: tree,
};
const pr: ControlUiSessionPullRequest = {
  owner: "owner",
  repo: "repo",
  number: 1,
  branch: "feature",
  title: "Work",
  url: "https://github.com/owner/repo/pull/1",
  state: "merged",
  headSha: head,
};
const comparison = {
  status: "ahead",
  base_commit: { sha: source, commit: { tree: { sha: tree } } },
  merge_base_commit: { sha: source },
};

beforeEach(() => {
  vi.spyOn(gitHubPublicApi, "resolveGitHubApiCredentialScope").mockReturnValue({
    token: "synthetic-test-token",
    cacheScope: "fixture",
    apiBaseUrl: "https://api.github.com",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function responses(publishedTree = "4".repeat(40), compared: unknown = comparison) {
  return vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          requestUrl(input).includes("/compare/")
            ? compared
            : { sha: head, tree: { sha: publishedTree } },
        ),
        { status: 200 },
      ),
  );
}
const current = () => {};

it.each(["github.com", "ghe.example.test"])(
  "reads publication history at the recorded %s host on an Enterprise Gateway",
  async (host) => {
    vi.mocked(gitHubPublicApi.resolveGitHubApiCredentialScope).mockRestore();
    vi.stubEnv("GH_TOKEN", "synthetic-unrelated-public-token");
    vi.stubEnv("GITHUB_TOKEN", "");
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
        controlUi: {
          github: { host: "ghe.example.test", token: "synthetic-enterprise-history-token" },
        },
      },
    });
    const fetchImpl = responses(tree);
    expect(
      await isGitHubPublicationSuperseded(
        snapshot,
        [{ ...pr, url: `https://${host}/owner/repo/pull/1` }],
        {
          fetchImpl,
          assertCurrent: current,
        },
      ),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `${host === "github.com" ? "https://api.github.com" : "https://ghe.example.test/api/v3"}/repos/owner/repo/git/commits/${head}`,
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      host === "github.com" ? null : "Bearer synthetic-enterprise-history-token",
    );
  },
);

it.each(["open", "draft", "merged"] as const)(
  "recognizes a failed committed snapshot in %s PR history",
  async (state) => {
    const fetchImpl = responses();
    expect(
      await isGitHubPublicationSuperseded(snapshot, [{ ...pr, state }], {
        fetchImpl,
        assertCurrent: current,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining(`compare/${source}...${head}?per_page=1&page=2`),
    );
  },
);

it.each(["missing", "malformed"])("checks later matching PRs after a %s head", async (failure) => {
  const missingHead = "6".repeat(40);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (requestUrl(input).endsWith(missingHead)) {
      return failure === "missing"
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify({ sha: missingHead, tree: null }));
    }
    return new Response(JSON.stringify({ sha: head, tree: { sha: tree } }));
  });
  expect(
    await isGitHubPublicationSuperseded(snapshot, [{ ...pr, headSha: missingHead }, pr], {
      fetchImpl,
      assertCurrent: current,
    }),
  ).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("recognizes an exact published tree even when the accepted work was uncommitted", async () => {
  const fetchImpl = responses(tree);
  expect(
    await isGitHubPublicationSuperseded({ ...snapshot, source_head_commit: null }, [pr], {
      fetchImpl,
      assertCurrent: current,
    }),
  ).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it.each([
  { branch: "another-branch" },
  { repo: "another-repo" },
  { state: "closed" as const },
  { headSha: undefined },
])("does not use an unrelated or unpublished PR: %j", async (change) => {
  const fetchImpl = responses(tree);
  expect(
    await isGitHubPublicationSuperseded(snapshot, [{ ...pr, ...change }], {
      fetchImpl,
      assertCurrent: current,
    }),
  ).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([
  {
    name: "newer unpublished snapshot",
    accepted: { ...snapshot, workspace_tree: "5".repeat(40) },
    compared: comparison,
  },
  { name: "diverged history", accepted: snapshot, compared: { ...comparison, status: "diverged" } },
  {
    name: "wrong merge base",
    accepted: snapshot,
    compared: { ...comparison, merge_base_commit: { sha: head } },
  },
  { name: "unreadable comparison", accepted: snapshot, compared: null },
])("retains failure for $name", async ({ accepted, compared }) => {
  expect(
    await isGitHubPublicationSuperseded(accepted, [pr], {
      fetchImpl: responses(undefined, compared),
      assertCurrent: current,
    }),
  ).toBe(false);
});

it("honors rate-limit cooldown without retrying anonymously or treating it as completion", async () => {
  const fetchImpl = vi.fn(
    async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      await isGitHubPublicationSuperseded(snapshot, [pr], { fetchImpl, assertCurrent: current }),
    ).toBe(false);
  }
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("revalidates session authority after an awaited response before retiring a failure", async () => {
  let active = true;
  const fetchImpl = vi.fn(async () => {
    active = false;
    return new Response(JSON.stringify({ sha: head, tree: { sha: tree } }));
  });
  await expect(
    isGitHubPublicationSuperseded(snapshot, [pr], {
      fetchImpl,
      assertCurrent: () => {
        if (!active) {
          throw new Error("Session retired");
        }
      },
    }),
  ).rejects.toThrow("Session retired");
  expect(fetchImpl).toHaveBeenCalledOnce();
});
