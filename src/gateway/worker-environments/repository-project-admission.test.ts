import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedGitHubSourceReadIdentity } from "../../agents/github-read-identity.js";

const mocks = vi.hoisted(() => ({
  captureAgentLifecycleBinding: vi.fn(),
  matchesAgentLifecycleBinding: vi.fn(),
  prepareGitHubReadIdentity: vi.fn(),
  prepareGitPack: vi.fn(),
}));
vi.mock("../../agents/agent-lifecycle-registry.js", () => ({
  captureAgentLifecycleBinding: mocks.captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding: mocks.matchesAgentLifecycleBinding,
}));
vi.mock("../../agents/github-tool-identity.js", async () => ({
  GitHubIdentityError: (await import("../../agents/github-read-identity.js")).GitHubIdentityError,
  prepareGitHubReadIdentity: mocks.prepareGitHubReadIdentity,
}));
vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: () => undefined,
}));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: async () => {},
}));
vi.mock("./repository-git-pack.js", () => ({
  prepareRepositoryWorkerGitPack: mocks.prepareGitPack,
}));

import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";

const commit = "a".repeat(40);
const rootTree = "b".repeat(40);
const setupTree = "c".repeat(40);
const recipe = "d".repeat(40);
const repositoryUrl = "https://github.com/acme/project.git";
const agent = { agentId: "main", provenance: null };
const initial = {
  repository: { agentId: "main", url: repositoryUrl },
  namespace: "test-gateway",
  getConfig: () => ({}),
  assertCurrent: () => {},
};

describe("repository project admission", () => {
  let selection: PreparedGitHubSourceReadIdentity["selection"];
  let token: string | undefined;
  let selected: boolean;
  let repositoryId: string;
  let privateRepository: boolean;
  let recipeMode: string;
  let truncated: boolean;
  let unavailable: boolean;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  const repositoryNode = () => ({
    __typename: "Repository",
    node_id: repositoryId,
    clone_url: repositoryUrl.replace(/\.git$/u, ""),
    private: privateRepository,
    object: { __typename: "Commit", sha: commit, tree: { sha: rootTree } },
  });
  const requestPaths = () =>
    fetchImpl.mock.calls.map(([input]) => new URL(new Request(input).url).pathname);

  beforeEach(() => {
    selection = { source: "system-configured", profileId: `ghp_${"1".repeat(32)}`, accountId: 1 };
    token = "synthetic-github-source-token";
    selected = true;
    repositoryId = "R_fixture_project";
    privateRepository = false;
    recipeMode = "100755";
    truncated = false;
    unavailable = false;
    mocks.captureAgentLifecycleBinding.mockReset().mockReturnValue(agent);
    mocks.prepareGitPack.mockReset().mockResolvedValue("/synthetic/source.pack");
    mocks.matchesAgentLifecycleBinding.mockReset().mockReturnValue(true);
    mocks.prepareGitHubReadIdentity.mockReset().mockImplementation(async ({ assertActive }) => {
      assertActive();
      const admittedToken = token;
      const assertSelected = () => {
        assertActive();
        if (!selected) {
          throw new Error("GitHub identity changed");
        }
      };
      return {
        token: admittedToken,
        selection: structuredClone(selection),
        cacheScope: "credential-scoped-memory-only",
        assertSelected,
        revalidate: async () => {
          assertSelected();
          if (admittedToken !== token) {
            throw new Error("GitHub credential changed");
          }
        },
      };
    });
    fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      let value: unknown;
      if (url.pathname === "/graphql") {
        if (unavailable) {
          return new Response(null, { status: 404 });
        }
        value = { data: { node: repositoryNode() } };
      } else if (url.pathname === "/repos/acme/project") {
        if (unavailable) {
          return new Response(null, { status: 404 });
        }
        value = {
          node_id: repositoryId,
          clone_url: repositoryUrl,
          private: privateRepository,
          default_branch: "main",
        };
      } else if (url.pathname.startsWith("/repos/acme/project/commits/")) {
        value = { sha: commit, commit: { tree: { sha: rootTree } } };
      } else if (url.pathname === `/repos/acme/project/git/commits/${commit}`) {
        value = { sha: commit, tree: { sha: rootTree } };
      } else if (url.pathname === `/repos/acme/project/git/trees/${rootTree}`) {
        value = {
          sha: rootTree,
          truncated,
          tree: [{ path: ".openclaw", type: "tree", mode: "040000", sha: setupTree }],
        };
      } else if (url.pathname === `/repos/acme/project/git/trees/${setupTree}`) {
        value = {
          sha: setupTree,
          truncated,
          tree: [{ path: "worktree-setup.sh", type: "blob", mode: recipeMode, sha: recipe }],
        };
      } else {
        throw new Error("Unexpected fixture metadata request");
      }
      return new Response(JSON.stringify(value));
    });
    vi.stubGlobal("fetch", fetchImpl);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "HEAD", "tags/v1", "refs/tags/v1", "feature/ready"])(
    "pins %s through the commit resolver and records executable recipe identity without credentials",
    async (ref) => {
      const result = await prepareRepositoryWorkerProjectSource({
        ...initial,
        repository: { ...initial.repository, ref },
      });
      expect(result.project).toMatchObject({
        baseCommit: commit,
        source: {
          kind: "repository",
          url: repositoryUrl,
          repositoryId,
          owner: { agent, identity: selection },
        },
      });
      expect(result.setupRecipe).toBe(recipe);
      const urls = fetchImpl.mock.calls.map(([url]) => new Request(url).url);
      const expectedRef =
        ref === undefined || ref === "HEAD" ? "heads/main" : ref.replace(/^refs\//u, "");
      expect(urls).toContain(
        `https://api.github.com/repos/acme/project/commits/${encodeURIComponent(expectedRef)}?per_page=1`,
      );
      expect(urls.every((url) => !url.includes("recursive"))).toBe(true);
      expect(JSON.stringify(result.project)).not.toContain(token);
      expect(JSON.stringify(result.project)).not.toContain("credential-scoped-memory-only");
      expect(result.project).not.toHaveProperty("root");
    },
  );

  it("refills from the pinned descriptor and accepts credential rotation for the same source owner", async () => {
    const result = await prepareRepositoryWorkerProjectSource(initial);
    token = "rotated-synthetic-token";
    await expect(result.revalidate()).resolves.toBeUndefined();
    expect(result).not.toHaveProperty("readGitToken");
    fetchImpl.mockClear();
    const restored = await prepareRepositoryWorkerProjectSource({
      namespace: initial.namespace,
      getConfig: initial.getConfig,
      assertCurrent: initial.assertCurrent,
      expected: result.project,
    });
    expect(restored.project).toEqual(result.project);
    expect(restored.setupRecipe).toBe(recipe);
    expect(
      fetchImpl.mock.calls.every(([url]) => !new Request(url).url.includes("/commits/heads")),
    ).toBe(true);
  });

  it("uses seven reads across discovery, pinned admission, and post-binding revalidation", async () => {
    const admitted = await prepareRepositoryWorkerProjectSource({
      ...initial,
      knownRecipe: (project) => ({ project, setupRecipe: recipe }),
    });
    const restored = await prepareRepositoryWorkerProjectSource({
      namespace: initial.namespace,
      getConfig: initial.getConfig,
      assertCurrent: initial.assertCurrent,
      expected: admitted.project,
      knownRecipe: (project) => ({ project, setupRecipe: recipe }),
    });
    await restored.revalidate();
    expect(restored.project).toEqual(admitted.project);
    expect(requestPaths()).toEqual([
      "/repos/acme/project",
      "/repos/acme/project/commits/heads%2Fmain",
      "/repos/acme/project",
      "/graphql",
      "/repos/acme/project",
      "/graphql",
      "/repos/acme/project",
    ]);
    for (const [requestInput, init] of fetchImpl.mock.calls.filter(([input]) =>
      new Request(input).url.endsWith("/graphql"),
    )) {
      const request = new Request(requestInput, init);
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      const body = await request.json();
      expect(body.variables).toEqual({ repositoryId, commit });
      expect(body.query).toMatch(
        /node\(id: \$repositoryId\)[\s\S]*on Repository[\s\S]*object\(oid: \$commit\)/u,
      );
      expect(body.query).not.toMatch(/repository\(owner:/u);
    }
  });

  it.each(["refill", "revalidate"] as const)(
    "rejects invalid GraphQL repository/object metadata during %s without a REST fallback",
    async (phase) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const node = repositoryNode();
      const responses = [
        {},
        { data: null },
        { data: { node: null } },
        { data: { node: { ...node, __typename: "User" } } },
        { data: { node: { ...node, node_id: "R_replaced_project" } } },
        { data: { node: { ...node, clone_url: "https://github.com/acme/another" } } },
        { data: { node: { ...node, private: undefined } } },
        { data: { node: { ...node, private: true } } },
        { data: { node: { ...node, object: null } } },
        { data: { node: { ...node, object: { ...node.object, __typename: "Tree" } } } },
        { data: { node: { ...node, object: { ...node.object, sha: "e".repeat(40) } } } },
        { data: { node: { ...node, object: { ...node.object, tree: null } } } },
        { data: { node: { ...node, object: { ...node.object, tree: { sha: "invalid" } } } } },
        { data: { node }, errors: [{ type: "FORBIDDEN" }] },
        { data: { node }, errors: [{ type: "INTERNAL", message: "private-diagnostic" }] },
        { data: { node }, errors: {} },
        { errors: [{ type: "FORBIDDEN" }, { type: "INTERNAL" }] },
      ];
      for (const response of responses) {
        fetchImpl.mockClear().mockResolvedValueOnce(new Response(JSON.stringify(response)));
        const pending =
          phase === "revalidate"
            ? admitted.revalidate()
            : prepareRepositoryWorkerProjectSource({
                namespace: initial.namespace,
                getConfig: initial.getConfig,
                assertCurrent: initial.assertCurrent,
                expected: admitted.project,
                knownRecipe: (project) => ({ project, setupRecipe: recipe }),
              });
        await expect(pending).rejects.toThrow();
        expect(requestPaths()).toEqual(["/graphql"]);
      }
    },
  );

  it.each(["repository", "visibility", "access"] as const)(
    "rejects %s changes after the immutable-node read",
    async (change) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const response = { data: { node: repositoryNode() } };
      fetchImpl.mockClear().mockImplementationOnce(async () => {
        if (change === "repository") {
          repositoryId = "R_recreated_project";
        }
        if (change === "visibility") {
          privateRepository = true;
        }
        if (change === "access") {
          unavailable = true;
        }
        return new Response(JSON.stringify(response));
      });
      await expect(admitted.revalidate()).rejects.toThrow();
      expect(requestPaths()).toEqual(["/graphql", "/repos/acme/project"]);
    },
  );

  it.each(["http forbidden", "forbidden", "insufficient scopes"] as const)(
    "preserves the complete REST fence for a public token with %s GraphQL access",
    async (refusal) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      fetchImpl.mockClear().mockResolvedValueOnce(
        refusal === "http forbidden"
          ? new Response(
              JSON.stringify({ message: "Resource not accessible by personal access token" }),
              { status: 403 },
            )
          : new Response(
              JSON.stringify({
                data: null,
                errors: [{ type: refusal === "forbidden" ? "FORBIDDEN" : "INSUFFICIENT_SCOPES" }],
              }),
            ),
      );
      await expect(admitted.revalidate()).resolves.toBeUndefined();
      expect(requestPaths()).toEqual([
        "/graphql",
        "/repos/acme/project",
        `/repos/acme/project/git/commits/${commit}`,
        "/repos/acme/project",
      ]);
    },
  );

  it.each(["agent", "identity", "credential", "caller"] as const)(
    "rejects %s revocation after successful or refused GraphQL reads without falling back",
    async (revoked) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const originalToken = token;
      for (const status of [200, 403]) {
        selected = true;
        token = originalToken;
        mocks.matchesAgentLifecycleBinding.mockReturnValue(true);
        const controller = new AbortController();
        fetchImpl.mockClear().mockImplementationOnce(async () => {
          if (revoked === "agent") {
            mocks.matchesAgentLifecycleBinding.mockReturnValue(false);
          }
          if (revoked === "identity") {
            selected = false;
          }
          if (revoked === "credential") {
            token = "replaced-credential";
          }
          if (revoked === "caller") {
            controller.abort();
          }
          return new Response(
            JSON.stringify(
              status === 403
                ? { message: "Resource not accessible by personal access token" }
                : { data: { node: repositoryNode() } },
            ),
            { status },
          );
        });
        await expect(admitted.revalidate(controller.signal)).rejects.toThrow();
        expect(requestPaths()).toEqual(["/graphql"]);
      }
    },
  );

  it.each<{ label: string; status: number; body?: string; headers?: Record<string, string> }>([
    { label: "authentication", status: 401, body: "{}" },
    { label: "missing endpoint", status: 404, body: "{}" },
    { label: "upstream failure", status: 500, body: "{}" },
    { label: "malformed JSON", status: 200, body: "{" },
    { label: "ambiguous forbidden", status: 403, body: "{}" },
    { label: "empty forbidden", status: 403 },
    {
      label: "quota at HTTP 403",
      status: 403,
      headers: { "x-ratelimit-remaining": "42" },
      body: JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }),
    },
    { label: "quota", status: 200, body: JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }) },
    { label: "redirect", status: 307, headers: { location: "https://api.github.com/graphql" } },
  ])(
    "does not reinterpret $label as unavailable GraphQL capability",
    async ({ status, body, headers }) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      fetchImpl.mockClear().mockResolvedValueOnce(new Response(body, { status, headers }));
      await expect(admitted.revalidate()).rejects.toThrow();
      expect(requestPaths()).toEqual(["/graphql"]);
    },
  );

  it.each([undefined, recipe])(
    "reuses an exact known recipe %s without Git tree reads",
    async (setupRecipe) => {
      recipeMode = setupRecipe ? "100755" : "100644";
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      expect(admitted.setupRecipe).toBe(setupRecipe);
      fetchImpl.mockClear();
      const knownRecipe = vi.fn(() => ({ project: admitted.project, setupRecipe }));
      const result = await prepareRepositoryWorkerProjectSource({ ...initial, knownRecipe });
      expect(result.project).toEqual(admitted.project);
      expect(result.setupRecipe).toBe(setupRecipe);
      expect(knownRecipe).toHaveBeenCalledExactlyOnceWith(admitted.project);
      expect(
        fetchImpl.mock.calls.map(([input]) => new URL(new Request(input).url).pathname),
      ).toEqual([
        "/repos/acme/project",
        "/repos/acme/project/commits/heads%2Fmain",
        "/repos/acme/project",
      ]);
    },
  );

  it("discovers the recipe normally when the owner has no matching immutable facts", async () => {
    const result = await prepareRepositoryWorkerProjectSource({
      ...initial,
      knownRecipe: () => undefined,
    });
    expect(result.setupRecipe).toBe(recipe);
    expect(
      fetchImpl.mock.calls.filter(([input]) => new Request(input).url.includes("/git/trees/")),
    ).toHaveLength(2);
  });

  it.each(["commit", "repository", "identity"] as const)(
    "rejects old recipe facts after %s changes",
    async (changed) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const original = fetchImpl.getMockImplementation()!;
      if (changed === "commit") {
        fetchImpl.mockImplementation(async (...args) => {
          if (new Request(args[0]).url.includes("/commits/heads")) {
            return new Response(
              JSON.stringify({ sha: "e".repeat(40), commit: { tree: { sha: rootTree } } }),
            );
          }
          return await original(...args);
        });
      } else if (changed === "repository") {
        repositoryId = "R_recreated_project";
      } else {
        selection = {
          source: "system-configured",
          profileId: `ghp_${"1".repeat(32)}`,
          accountId: 2,
        };
      }
      fetchImpl.mockClear();
      await expect(
        prepareRepositoryWorkerProjectSource({
          ...initial,
          knownRecipe: () => ({ project: admitted.project, setupRecipe: admitted.setupRecipe }),
        }),
      ).rejects.toThrow("identity changed");
      expect(
        fetchImpl.mock.calls.every(([input]) => !new Request(input).url.includes("/git/trees/")),
      ).toBe(true);
    },
  );

  it("rejects malformed or mutated known facts without silently rediscovering a recipe", async () => {
    await expect(
      prepareRepositoryWorkerProjectSource({
        ...initial,
        knownRecipe: (project) => ({ project, setupRecipe: "invalid-object-identity" }),
      }),
    ).rejects.toThrow("identity changed");
    await expect(
      prepareRepositoryWorkerProjectSource({
        ...initial,
        knownRecipe: (project) => {
          project.baseCommit = "e".repeat(40);
          return { project, setupRecipe: recipe };
        },
      }),
    ).rejects.toThrow("identity changed");
    expect(
      fetchImpl.mock.calls.every(([input]) => !new Request(input).url.includes("/git/trees/")),
    ).toBe(true);
  });

  it("still rejects access loss after a known recipe hit", async () => {
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    fetchImpl.mockClear();
    await expect(
      prepareRepositoryWorkerProjectSource({
        ...initial,
        knownRecipe: () => {
          unavailable = true;
          return { project: admitted.project, setupRecipe: admitted.setupRecipe };
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.every(([input]) => !new Request(input).url.includes("/git/trees/")),
    ).toBe(true);
  });

  it.each(["100644", "120000", "160000"])("does not authorize setup from mode %s", async (mode) => {
    recipeMode = mode;
    expect((await prepareRepositoryWorkerProjectSource(initial)).setupRecipe).toBeUndefined();
  });

  it("rejects incomplete trees rather than interpreting a missing recipe as no setup", async () => {
    truncated = true;
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow(
      "tree metadata is incomplete",
    );
  });

  it("rejects oversized metadata and cross-repository redirects without a second request", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) })),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("size limit");
    fetchImpl.mockClear().mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/acme/another" },
      }),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("identity changed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses changed or inaccessible repository instances on a prepared hit", async () => {
    const result = await prepareRepositoryWorkerProjectSource(initial);
    repositoryId = "R_recreated_project";
    await expect(result.revalidate()).rejects.toThrow("identity changed");
    repositoryId = "R_fixture_project";
    unavailable = true;
    fetchImpl.mockClear();
    await expect(result.revalidate()).rejects.toThrow("HTTP 404");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it("admits private source with a separate key and retains credentials only in the pack producer", async () => {
    const publicSource = await prepareRepositoryWorkerProjectSource(initial);
    expect(publicSource.project.key).toBe(
      "5f3a252d4721416c63de96e5736650e1b83d356e31df48b7442ec4d60ea17189",
    );
    expect(publicSource.prepareGitPack).toBeUndefined();
    privateRepository = true;
    const admitted = await prepareRepositoryWorkerProjectSource(initial);
    expect(admitted).toBeDefined();
    expect(admitted.project.key).not.toBe(publicSource.project.key);
    expect(admitted.project.source).toEqual(publicSource.project.source);
    expect(JSON.stringify(admitted)).not.toContain(token);
    const storedProject = JSON.stringify(admitted.project);
    const reopened = await prepareRepositoryWorkerProjectSource({
      namespace: initial.namespace,
      getConfig: initial.getConfig,
      assertCurrent: initial.assertCurrent,
      expected: JSON.parse(storedProject),
    });
    expect(reopened.project).toEqual(admitted.project);
    token = "rotated-synthetic-token";
    const signal = new AbortController().signal;
    await expect(reopened.prepareGitPack!({ temporaryRoot: "/synthetic", signal })).resolves.toBe(
      "/synthetic/source.pack",
    );
    expect(mocks.prepareGitPack).toHaveBeenCalledExactlyOnceWith({
      url: repositoryUrl,
      baseCommit: commit,
      token,
      temporaryRoot: "/synthetic",
      signal,
      assertCurrent: expect.any(Function),
    });
  });

  it.each(["caller", "account", "visibility", "during fetch"] as const)(
    "rejects private pack preparation after %s authority changes",
    async (change) => {
      privateRepository = true;
      const caller = new AbortController();
      const admitted = await prepareRepositoryWorkerProjectSource({
        ...initial,
        signal: caller.signal,
      });
      if (change === "caller") {
        caller.abort();
      }
      if (change === "account") {
        selected = false;
      }
      if (change === "visibility") {
        privateRepository = false;
      }
      if (change === "during fetch") {
        mocks.prepareGitPack.mockImplementationOnce(async () => {
          selected = false;
          return "/synthetic/source.pack";
        });
      }
      await expect(
        admitted.prepareGitPack!({
          temporaryRoot: "/synthetic",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(mocks.prepareGitPack).toHaveBeenCalledTimes(change === "during fetch" ? 1 : 0);
    },
  );

  it.each(["refill", "revalidate"] as const)(
    "rejects public-to-private visibility drift during %s",
    async (phase) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      expect(admitted.project.source).not.toHaveProperty("private");
      privateRepository = true;
      const changed =
        phase === "revalidate"
          ? admitted.revalidate()
          : prepareRepositoryWorkerProjectSource({
              namespace: initial.namespace,
              getConfig: initial.getConfig,
              assertCurrent: initial.assertCurrent,
              expected: admitted.project,
            });
      await expect(changed).rejects.toThrow("identity changed");
    },
  );

  it("rejects visibility changes while the initial commit and recipe are being admitted", async () => {
    const implementation = fetchImpl.getMockImplementation()!;
    let repositoryReads = 0;
    fetchImpl.mockImplementation(async (input, init) => {
      if (
        new URL(new Request(input, init).url).pathname === "/repos/acme/project" &&
        ++repositoryReads === 2
      ) {
        privateRepository = true;
      }
      return implementation(input, init);
    });
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow("identity changed");
  });

  it("separates anonymous scope and does not accept a private response without identity", async () => {
    const authenticated = await prepareRepositoryWorkerProjectSource(initial);
    token = undefined;
    selection = { source: "anonymous" };
    const anonymous = await prepareRepositoryWorkerProjectSource(initial);
    expect(anonymous.project.key).not.toBe(authenticated.project.key);
    expect(anonymous.project.source.owner.identity).toEqual({ source: "anonymous" });
    privateRepository = true;
    await expect(anonymous.revalidate()).rejects.toThrow("identity changed");
  });

  it("fences owner replacement while allowing a completed admission's caller to close", async () => {
    let active = true;
    const controller = new AbortController();
    const result = await prepareRepositoryWorkerProjectSource({
      ...initial,
      signal: controller.signal,
      assertCurrent: () => {
        if (!active) {
          throw new Error("caller closed");
        }
      },
    });
    active = false;
    controller.abort();
    await expect(result.revalidate()).resolves.toBeUndefined();
    selection = { source: "system-configured", profileId: `ghp_${"1".repeat(32)}`, accountId: 2 };
    await expect(result.revalidate()).rejects.toThrow("identity changed");
    mocks.matchesAgentLifecycleBinding.mockReturnValue(false);
    expect(result.assertCurrent).toThrow("identity changed");
  });

  it("does not admit a result after authority closes during a metadata await", async () => {
    const controller = new AbortController();
    const response = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementationOnce(async (...args) => {
      const value = await response(...args);
      controller.abort();
      return value;
    });
    await expect(
      prepareRepositoryWorkerProjectSource({ ...initial, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not expose native credential subprocess diagnostics as preparation errors", async () => {
    mocks.prepareGitHubReadIdentity.mockRejectedValueOnce(
      new Error("synthetic-private-diagnostic"),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow(
      "could not be verified",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["initial", "refill", "revalidate"] as const)(
    "cancels a pending %s HTTP read",
    async (phase) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      const controller = new AbortController();
      const started = createDeferred();
      fetchImpl.mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("HTTP request has no cancellation signal");
        }
        started.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
      const request =
        phase === "initial"
          ? prepareRepositoryWorkerProjectSource({ ...initial, signal: controller.signal })
          : phase === "refill"
            ? prepareRepositoryWorkerProjectSource({
                namespace: initial.namespace,
                getConfig: initial.getConfig,
                assertCurrent: initial.assertCurrent,
                expected: admitted.project,
                signal: controller.signal,
              })
            : admitted.revalidate(controller.signal);
      await started.promise;
      controller.abort();
      await expect(request).rejects.toThrow();
    },
  );

  it("rejects mixed local/remote descriptors and unexpected persisted owner fields", async () => {
    const { project } = await prepareRepositoryWorkerProjectSource(initial);
    expect(readRepositoryWorkerProjectSnapshot({ ...project, preparation: {} })).toEqual(project);
    expect(() => readRepositoryWorkerProjectSnapshot({ ...project, root: "/local" })).toThrow(
      "invalid repository",
    );
    expect(() =>
      readRepositoryWorkerProjectSnapshot({ ...project, token: "unpersistable" }),
    ).toThrow("invalid repository");
    expect(() =>
      readRepositoryWorkerProjectSnapshot({
        ...project,
        source: {
          ...project.source,
          owner: { ...project.source.owner, token: "unpersistable" },
        },
      }),
    ).toThrow("invalid repository");
  });
});
