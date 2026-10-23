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
  vi.unstubAllGlobals();
});

const requestUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
const json = (value: unknown) => new Response(JSON.stringify(value));
const published = (sha = head, publishedTree: string | null = tree) => ({
  sha,
  tree: publishedTree === null ? null : { sha: publishedTree },
});
function responses(publishedTree = "4".repeat(40), compared: unknown = comparison) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    json(requestUrl(input).includes("/compare/") ? compared : published(head, publishedTree)),
  );
}
const check = (
  fetchImpl: typeof fetch,
  accepted: Scenario["snapshot"] = {},
  pullRequests = [pr],
  assertCurrent = () => {},
) => {
  vi.stubGlobal("fetch", fetchImpl);
  return isGitHubPublicationSuperseded({ ...snapshot, ...accepted }, pullRequests, {
    assertCurrent,
  });
};

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
    expect(await check(fetchImpl, {}, [{ ...pr, url: `https://${host}/owner/repo/pull/1` }])).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    const publicHost = host === "github.com";
    const api = publicHost ? "https://api.github.com" : "https://ghe.example.test/api/v3";
    expect({ url, authorization: new Headers(init?.headers).get("Authorization") }).toEqual({
      url: `${api}/repos/owner/repo/git/commits/${head}`,
      authorization: publicHost ? null : "Bearer synthetic-enterprise-history-token",
    });
  },
);

type Scenario = {
  snapshot?: Partial<Parameters<typeof isGitHubPublicationSuperseded>[0]>;
  pr?: Partial<ControlUiSessionPullRequest>;
  tree?: string;
  compared?: unknown;
};
it.each<[name: string, input: Scenario, superseded: boolean, calls?: number]>([
  ["committed open history", { pr: { state: "open" } }, true, 2],
  ["committed draft history", { pr: { state: "draft" } }, true, 2],
  ["committed merged history", { pr: { state: "merged" } }, true, 2],
  ["uncommitted exact tree", { snapshot: { source_head_commit: null }, tree }, true, 1],
  ["another branch", { pr: { branch: "another-branch" }, tree }, false, 0],
  ["another repository", { pr: { repo: "another-repo" }, tree }, false, 0],
  ["closed PR", { pr: { state: "closed" }, tree }, false, 0],
  ["unpublished PR", { pr: { headSha: undefined }, tree }, false, 0],
  ["newer unpublished snapshot", { snapshot: { workspace_tree: "5".repeat(40) } }, false],
  ["diverged history", { compared: { ...comparison, status: "diverged" } }, false],
  ["wrong merge base", { compared: { ...comparison, merge_base_commit: { sha: head } } }, false],
  ["unreadable comparison", { compared: null }, false],
])("checks publication coverage for %s", async (_name, input, superseded, calls) => {
  const fetchImpl = responses(input.tree, input.compared);
  expect(await check(fetchImpl, input.snapshot, [{ ...pr, ...input.pr }])).toBe(superseded);
  if (calls !== undefined) {
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  }
  if (superseded && calls === 2) {
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(
      expect.stringContaining(`compare/${source}...${head}?per_page=1&page=2`),
    );
  }
});

it.each(["missing", "malformed"])("checks later matching PRs after a %s head", async (failure) => {
  const missingHead = "6".repeat(40);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (requestUrl(input).endsWith(missingHead)) {
      return failure === "missing"
        ? new Response("missing", { status: 404 })
        : json(published(missingHead, null));
    }
    return json(published());
  });
  expect(await check(fetchImpl, {}, [{ ...pr, headSha: missingHead }, pr])).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("honors rate-limit cooldown without retrying anonymously or treating it as completion", async () => {
  const fetchImpl = vi.fn(
    async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await check(fetchImpl)).toBe(false);
  }
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("revalidates session authority after an awaited response before retiring a failure", async () => {
  let active = true;
  const fetchImpl = vi.fn(async () => {
    active = false;
    return json(published());
  });
  await expect(
    check(fetchImpl, {}, [pr], () => {
      if (!active) {
        throw new Error("Session retired");
      }
    }),
  ).rejects.toThrow("Session retired");
  expect(fetchImpl).toHaveBeenCalledOnce();
});
