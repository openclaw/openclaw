import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedGitHubSourceReadIdentity } from "../../agents/github-read-identity.js";
import { createGitHubReadIdentity } from "../../agents/github-read-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";

const mocks = vi.hoisted(() => ({
  captureAgentLifecycleBinding: vi.fn(),
  matchesAgentLifecycleBinding: vi.fn(),
  prepareGitHubReadIdentity: vi.fn(),
  prepareGitPack: vi.fn(),
  phaseLog: vi.fn(),
  credentialReads: vi.fn(),
  workspace: vi.fn(),
  advance: vi.fn(),
  publication: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../state/session-repository-workspaces.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: () => ({
    find: mocks.workspace,
    advanceToPublishedHead: mocks.advance,
  }),
}));
vi.mock("../github-repository-publication-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-repository-publication-store.js")>()),
  prepareRepositoryGitHubPublicationBranch: mocks.publication,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => {
      const log = original.createSubsystemLogger(name);
      return name === "gateway/repository-admission" || name === "github/api"
        ? { ...log, info: mocks.phaseLog }
        : log;
    },
  };
});
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
import { prepareRepositoryRefRecovery } from "./repository-recovery-checkpoint.js";

const commit = "a".repeat(40);
const rootTree = "b".repeat(40);
const setupTree = "c".repeat(40);
const recipe = "d".repeat(40);
const repositoryUrl = "https://github.com/acme/project.git";
let observedRepositoryUrl = repositoryUrl;
const agent = { agentId: "main", provenance: null };
const admission = {
  namespace: "test-gateway",
  getConfig: () => ({}),
  assertCurrent: () => {},
};
const initial = { ...admission, repository: { agentId: "main", url: repositoryUrl } };

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
    clone_url: observedRepositoryUrl.replace(/\.git$/u, ""),
    private: privateRepository,
    object: { __typename: "Commit", sha: commit, tree: { sha: rootTree } },
  });
  const requestPaths = () =>
    fetchImpl.mock.calls.map(([input]) => new URL(new Request(input).url).pathname);

  beforeEach(() => {
    mocks.phaseLog.mockReset();
    observedRepositoryUrl = repositoryUrl;
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
    mocks.credentialReads.mockReset().mockImplementation(async () => token);
    mocks.prepareGitHubReadIdentity.mockReset().mockImplementation(async ({ assertActive }) => {
      assertActive();
      const admittedToken = token;
      const assertSelected = () => {
        assertActive();
        if (!selected) {
          throw new Error("GitHub identity changed");
        }
      };
      return createGitHubReadIdentity({
        ...(admittedToken === undefined || selection.source === "anonymous"
          ? { token: undefined, selection: { source: "anonymous" } as const }
          : { token: admittedToken, selection: structuredClone(selection) }),
        assertSelected,
        readToken: mocks.credentialReads,
      });
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
          clone_url: observedRepositoryUrl,
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
    mocks.advance.mockReset().mockImplementation(async ({ assertCurrent }) => assertCurrent());
    mocks.workspace.mockReset();
    mocks.release.mockReset();
    mocks.publication.mockReset();
  });

  it.each([
    "unpublished",
    "uninitialized",
    "uninitialized original branch",
    "uninitialized attempted",
    "uninitialized checkpoint",
    "attempted",
    "deleted",
    "unknown effect",
    "external branch",
    "revoked",
  ] as const)(
    "recovers only a proven generated local branch from its original immutable base: %s",
    async (state) => {
      const workspaceId = "db9ec53a-081a-4343-8bf8-64810cf01793";
      const branch = state === "uninitialized original branch" ? "main" : `clawson/${workspaceId}`;
      const workspace: SessionRepositoryWorkspaceRecord = {
        workspaceId,
        agentId: "main",
        sessionKey: "agent:main:original",
        url: repositoryUrl,
        requestedRef: state === "external branch" ? `refs/heads/${branch}` : "main",
        branch,
        baseCommit: state.startsWith("uninitialized") ? null : commit,
        runSetupScript: false,
        revision: state.startsWith("uninitialized") ? 0 : 4,
        baseManifestHash: null,
        checkpointRef:
          state === "uninitialized checkpoint" ? "refs/openclaw/worker-results/held" : null,
        manifestHash: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      mocks.workspace.mockResolvedValue(workspace);
      mocks.publication.mockResolvedValue({
        current: () => ({
          attempted:
            state === "attempted" ||
            state === "uninitialized attempted" ||
            state === "deleted" ||
            state === "unknown effect",
          unsettled: state === "unknown effect",
          head: state === "deleted" ? { pushed_head_commit: "e".repeat(40) } : undefined,
        }),
        release: mocks.release,
      });
      const transport = fetchImpl.getMockImplementation()!;
      fetchImpl.mockImplementation(async (input, init) => {
        if (state === "revoked") {
          selected = false;
        }
        if (new Request(input).url.includes("/commits/heads%2Fclawson")) {
          return new Response(JSON.stringify({ message: "No commit found" }), { status: 422 });
        }
        return transport(input, init);
      });
      const recovered = prepareRepositoryRefRecovery({
        profileId: "development",
        executionMode: "remote-exec",
        agentId: "main",
        sessionKey: workspace.sessionKey,
        sessionId: "original",
        assertCurrent: () => {},
      });
      if (
        state === "unpublished" ||
        state === "uninitialized" ||
        state === "uninitialized original branch"
      ) {
        await recovered;
        expect(mocks.advance).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId,
            expectedRevision: workspace.revision,
            branch,
            headCommit: commit,
            preserveRequestedRef: true,
          }),
        );
        expect(requestPaths()).toContain(
          state === "uninitialized original branch"
            ? "/repos/acme/project/commits/heads%2Fmain"
            : state === "uninitialized"
              ? "/repos/acme/project/commits/main"
              : `/repos/acme/project/git/commits/${commit}`,
        );
        expect(requestPaths().some((value) => value.includes("/commits/heads%2Fclawson"))).toBe(
          false,
        );
      } else {
        await expect(recovered).rejects.toThrow();
        expect(mocks.advance).not.toHaveBeenCalled();
        if (state !== "unknown effect" && state !== "revoked") {
          expect(requestPaths()).toContain(
            `/repos/acme/project/commits/heads%2Fclawson%2F${workspaceId}`,
          );
        }
      }
      expect(workspace).toMatchObject({
        revision: state.startsWith("uninitialized") ? 0 : 4,
        branch,
        baseCommit: state.startsWith("uninitialized") ? null : commit,
      });
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it("correlates exact source-ref422 with safe request ID and no raw error or credential", async () => {
    const transport = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (input, init) =>
      new Request(input).url.includes("/commits/")
        ? new Response(JSON.stringify({ message: "synthetic-private-error" }), {
            status: 422,
            headers: { "x-github-request-id": "ABCD:1234" },
          })
        : transport(input, init),
    );
    await expect(prepareRepositoryWorkerProjectSource(initial)).rejects.toThrow();
    expect(mocks.phaseLog).toHaveBeenCalledWith(
      "repository admission request",
      expect.objectContaining({
        operation: "source_ref",
        status: 422,
        githubRequestId: "ABCD:1234",
        outcome: "rejected",
      }),
    );
    const raw = JSON.stringify(mocks.phaseLog.mock.calls);
    expect(raw).not.toContain("synthetic-private-error");
    expect(raw).not.toContain(token);
  });

  it.each(["current", "credential changed", "authority revoked", "caller aborted"] as const)(
    "bounds metadata credential verification while preserving %s refusal",
    async (outcome) => {
      const transport = fetchImpl.getMockImplementation()!;
      const abort = new AbortController();
      let current = true;
      fetchImpl.mockImplementation(async (...args) => {
        const response = await transport(...args);
        if (fetchImpl.mock.calls.length === 3) {
          if (outcome === "credential changed") {
            token = "different-synthetic-credential";
          }
          if (outcome === "authority revoked") {
            current = false;
          }
          if (outcome === "caller aborted") {
            abort.abort();
          }
        }
        return response;
      });
      const pendingAdmission = prepareRepositoryWorkerProjectSource({
        ...initial,
        signal: abort.signal,
        assertCurrent: () => {
          abort.signal.throwIfAborted();
          if (!current) {
            throw new Error("Synthetic authority revoked");
          }
        },
      });
      if (outcome === "current") {
        const admitted = await pendingAdmission;
        expect(admitted.project.baseCommit).toBe(commit);
        expect(fetchImpl.mock.calls.length).toBeGreaterThan(3);
        expect(mocks.credentialReads).toHaveBeenCalledTimes(2);
      } else {
        await expect(pendingAdmission).rejects.toThrow();
        expect(mocks.prepareGitPack).not.toHaveBeenCalled();
      }
    },
  );
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearRuntimeConfigSnapshot();
  });

  it.each(["success", "error"] as const)(
    "observes identity admission before settlement and preserves its %s outcome",
    async (status) => {
      const entered = createDeferred();
      const settle = createDeferred();
      const original = mocks.prepareGitHubReadIdentity.getMockImplementation()!;
      mocks.prepareGitHubReadIdentity.mockImplementationOnce(async (params) => {
        entered.resolve();
        await settle.promise;
        return original(params);
      });
      const traceId = "1234567890abcdef1234567890abcdef";
      const request = runWithDiagnosticTraceContext({ traceId, spanId: "1234567890abcdef" }, () =>
        prepareRepositoryWorkerProjectSource(initial),
      );
      const outcome = request.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await entered.promise;
      try {
        expect(mocks.phaseLog).toHaveBeenCalledWith(
          "repository admission phase",
          expect.objectContaining({
            traceId,
            name: "identityAdmission",
            status: "entry",
            operation: "identity",
            admissionPhase: "prepare",
          }),
        );
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        if (status === "error") {
          settle.reject(new Error("synthetic-private-credential-diagnostic"));
        } else {
          settle.resolve();
        }
        await outcome;
      }
      const result = await outcome;
      expect(result.ok).toBe(status === "success");
      if (result.ok) {
        expect(result.value.project.baseCommit).toBe(commit);
        expect(mocks.phaseLog).toHaveBeenCalledWith(
          "repository admission phase",
          expect.objectContaining({ traceId, name: "responseBody", status: "success" }),
        );
        await runWithDiagnosticTraceContext({ traceId, spanId: "1234567890abcdef" }, () =>
          result.value.revalidate(),
        );
        for (const operation of ["pinned_repository", "repository_confirm"]) {
          expect(mocks.phaseLog).toHaveBeenCalledWith(
            "repository admission phase",
            expect.objectContaining({
              traceId,
              operation,
              admissionPhase: "revalidate",
              name: "authenticatedRequest",
              status: "success",
              durationMs: expect.any(Number),
            }),
          );
        }
      } else {
        expect(result.error).toMatchObject({ reason: "unverified" });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
      const records = mocks.phaseLog.mock.calls.map(([, fields]) => fields);
      const entry = records.find(
        (record) => record.name === "identityAdmission" && record.status === "entry",
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          traceId,
          requestSpanId: entry.requestSpanId,
          name: "identityAdmission",
          spanId: entry.spanId,
          status,
          durationMs: expect.any(Number),
        }),
      );
      expect(records.every((record) => record.traceId === traceId)).toBe(true);
      expect(JSON.stringify(records)).not.toMatch(
        /synthetic-private|synthetic-github-source-token|acme|project\.git/,
      );
    },
  );

  it("prepares an authenticated pack for an internal enterprise repository", async () => {
    setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
    observedRepositoryUrl = "https://ghe.example.test/acme/project.git";
    const admitted = await prepareRepositoryWorkerProjectSource({
      ...initial,
      repository: { ...initial.repository, url: observedRepositoryUrl },
    });

    expect(admitted).toHaveProperty("prepareGitPack");
    await expect(
      admitted.prepareGitPack?.({
        temporaryRoot: "/synthetic/temporary",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("/synthetic/source.pack");
    expect(mocks.prepareGitPack).toHaveBeenCalledWith(
      expect.objectContaining({ url: observedRepositoryUrl, token }),
    );
  });

  it.each([undefined, "HEAD", "refs/tags/v1", "feature/ready"])(
    "pins %s through the commit resolver and records executable recipe identity without credentials",
    async (ref) => {
      const result = await prepareRepositoryWorkerProjectSource({
        ...initial,
        repository: { ...initial.repository, ref },
        knownRecipe: () => undefined,
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
      expect(requestPaths().filter((path) => path.includes("/git/trees/"))).toHaveLength(2);
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
      ...admission,
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
      ...admission,
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
                ...admission,
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
    "rejects %s revocation before accepting GraphQL results or starting a refused-route fallback",
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
        expect(requestPaths()).toEqual(
          revoked === "credential" && status === 200
            ? ["/graphql", "/repos/acme/project"]
            : ["/graphql"],
        );
      }
    },
  );

  it.each<{ label: string; status: number; body?: string; headers?: Record<string, string> }>([
    { label: "authentication", status: 401, body: "{}" },
    { label: "missing endpoint", status: 404, body: "{}" },
    { label: "malformed JSON", status: 200, body: "{" },
    { label: "ambiguous forbidden", status: 403, body: "{}" },
    {
      label: "quota at HTTP 403",
      status: 403,
      headers: { "x-ratelimit-remaining": "42" },
      body: JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }),
    },
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
      expect(requestPaths()).toEqual([
        "/repos/acme/project",
        "/repos/acme/project/commits/heads%2Fmain",
        "/repos/acme/project",
      ]);
    },
  );

  it.each(["repository", "identity"] as const)(
    "rejects old recipe facts after %s changes",
    async (changed) => {
      const admitted = await prepareRepositoryWorkerProjectSource(initial);
      if (changed === "repository") {
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

  it.each(["120000", "160000"])("does not authorize setup from mode %s", async (mode) => {
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
      ...admission,
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
                ...admission,
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
