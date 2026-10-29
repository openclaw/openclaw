import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as githubReadIdentity from "../../agents/github-read-identity.js";
import * as runtimeOwnership from "../../agents/harness/session-runtime-ownership.js";
import * as worktreeGit from "../../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as combinedStoreRead from "../../config/sessions/combined-store-gateway-read.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.native.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gitWorker from "../../infra/git-worker.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import * as projectGitHubSearch from "../project-github-search.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import * as rowInputs from "../session-utils-row.js";
import {
  clonedProject,
  expectCheckoutInUse,
  expectProjectAccessChanged,
  projectConfig,
} from "./projects-shard.test-support.js";
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import {
  execFileAsync,
  initializeRepository,
  invokeProjectMethod as invoke,
  listRegistryRecords,
  projectsHandlers,
  resolveRepositoryIdentity,
  withProjectState,
} from "./projects.test-support.js";

const discoverRepository = resolveRepositoryIdentity.getMockImplementation()!;

function mockGitHubFetch() {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function nativeSearchConfig(host: string) {
  return {
    gateway: {
      github: { host, apiBaseUrl: `https://${host}/api/v3` },
      projects: { nativeGitHubSearch: true },
    },
  };
}

function searchRemote(
  cfg: OpenClawConfig,
  query: string,
  handlers = registeredProjectsHandlers,
  lifetime?: Parameters<typeof invoke>[8],
) {
  return invoke(
    "projects.searchRemote",
    { query },
    cfg,
    ["operator.write"],
    undefined,
    handlers,
    undefined,
    () => cfg,
    lifetime,
  );
}

function expectFetchAuthority(
  fetchImpl: ReturnType<typeof mockGitHubFetch>,
  url: RegExp,
  token: string | null,
) {
  expect(fetchImpl).toHaveBeenCalled();
  for (const [target, init] of fetchImpl.mock.calls) {
    expect(target).toMatch(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(token);
  }
}

function seedProjectSession(id: string, execCwd: string, entry: Partial<SessionEntry> = {}) {
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: `agent:main:${id}` },
    { sessionId: id, updatedAt: 1, execCwd, ...entry },
  );
}

type ListOptions = {
  observed?: boolean;
  scopes?: Parameters<typeof invoke>[3];
  profileId?: string;
  handlers?: Parameters<typeof invoke>[5];
  projection?: SessionRowProjection;
  getConfig?: () => OpenClawConfig;
};

function listProjects(cfg: OpenClawConfig = {}, options: ListOptions = {}) {
  return invoke(
    "projects.list",
    options.observed ? { includeObserved: true } : {},
    cfg,
    options.scopes,
    options.profileId,
    options.handlers,
    options.projection,
    options.getConfig,
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  listRegistryRecords.mockClear();
  resolveRepositoryIdentity.mockClear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("projects.searchRemote sends only the selected host's service credential", async () => {
  vi.stubEnv("GH_TOKEN", "public-host-token");
  const fetchImpl = mockGitHubFetch();
  const github = { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" };
  const boundConfig = {
    gateway: {
      github,
      controlUi: { github: { host: "ghe.example.test", token: "enterprise-service-token" } },
    },
  };
  setRuntimeConfigSnapshot(boundConfig);

  expect(
    await searchRemote(boundConfig, "enterprise-bound-request", projectsHandlers),
  ).toMatchObject({ ok: true, payload: { credential: "configured" } });
  expectFetchAuthority(
    fetchImpl,
    /^https:\/\/ghe\.example\.test\/api\/v3\//u,
    "Bearer enterprise-service-token",
  );

  fetchImpl.mockClear();
  const mismatchedConfig = {
    gateway: { github, controlUi: { github: { token: "public-service-token" } } },
  };
  setRuntimeConfigSnapshot(mismatchedConfig);
  expect(
    await searchRemote(mismatchedConfig, "enterprise-mismatched-request", projectsHandlers),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("host binding") },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("projects.searchRemote binds native tokens to the host through final fetch", async () => {
  const cfg = {
    ...nativeSearchConfig("a.ghe.example.test"),
    tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
    agents: {
      entries: {
        main: { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } },
      },
    },
  };
  const fetchImpl = mockGitHubFetch();
  setRuntimeConfigSnapshot(cfg);
  using native = vi
    .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
    .mockResolvedValue("host-a-token");
  expect(await searchRemote(cfg, "host-a-allowed", projectsHandlers)).toMatchObject({
    ok: true,
    payload: { credential: "configured" },
  });
  expectFetchAuthority(
    fetchImpl,
    /^https:\/\/a\.ghe\.example\.test\/api\/v3\//u,
    "Bearer host-a-token",
  );

  fetchImpl.mockClear();
  native.mockImplementation(async () => {
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "b.ghe.example.test", apiBaseUrl: "https://b.ghe.example.test/api/v3" },
      },
    });
    return "host-a-token";
  });
  expect(await searchRemote(cfg, "host-a-replaced", projectsHandlers)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("GitHub host changed") },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(["revoked", "aborted"] as const)(
  "registered projects.searchRemote refuses %s callers before credentialed I/O",
  async (closed) => {
    const cfg = nativeSearchConfig("a.ghe.example.test");
    setRuntimeConfigSnapshot(cfg);
    const controller = new AbortController();
    let active = true;
    const fetchImpl = mockGitHubFetch();
    using _ = vi
      .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
      .mockImplementation(async () => {
        if (closed === "aborted") {
          controller.abort();
        } else {
          active = false;
        }
        return "synthetic-host-a-token";
      });
    const result = await searchRemote(cfg, `closed-native-${closed}`, undefined, {
      signal: controller.signal,
      hasCurrentClientAuthority: () => active,
    });
    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

test("registered project search keeps an ambient Enterprise token at its declared host", async () => {
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "synthetic-host-a-ambient-token");
  vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "");
  vi.stubEnv("GH_HOST", "a.ghe.example.test");
  const fetchImpl = mockGitHubFetch();
  const allowed = nativeSearchConfig("a.ghe.example.test");
  setRuntimeConfigSnapshot(allowed);
  expect(await searchRemote(allowed, "ambient-allowed")).toMatchObject({ ok: true });
  expectFetchAuthority(
    fetchImpl,
    /^https:\/\/a\.ghe\.example\.test\//,
    "Bearer synthetic-host-a-ambient-token",
  );
  fetchImpl.mockClear();
  const forbidden = nativeSearchConfig("b.ghe.example.test");
  setRuntimeConfigSnapshot(forbidden);
  expect(await searchRemote(forbidden, "ambient-forbidden")).toMatchObject({ ok: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("registered anonymous native search does not borrow the service credential", async () => {
  using _ = vi
    .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
    .mockResolvedValue(undefined);
  const cfg = {
    gateway: {
      github: { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" },
      controlUi: { github: { host: "tenant.ghe.com", token: "synthetic-service-token" } },
      projects: { nativeGitHubSearch: true },
    },
  };
  const fetchImpl = mockGitHubFetch();
  setRuntimeConfigSnapshot(cfg);
  expect(await searchRemote(cfg, "anonymous-tenant")).toMatchObject({ ok: true });
  expect(fetchImpl).toHaveBeenCalled();
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  }
});

test("checkout options preserve permitted Current access without exposing paths", async () => {
  await withProjectState(async (state) => {
    const workspace = await initializeRepository(state.root, "workspace");
    const outside = await initializeRepository(state.root, "outside");
    const project = await registerProjectRegistry({ path: outside });
    using gitReads = vi.spyOn(worktreeGit, "runGit");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace, sandbox: { mode: "off" } } } },
    };
    for (const scopes of [
      ["operator.admin"],
      ["operator.sessions.read", "operator.sessions.write"],
    ]) {
      expect(
        await invoke(
          "projects.checkoutOptions",
          { projectId: project.id, agentId: "main" },
          cfg,
          scopes,
        ),
      ).toEqual({ ok: true, payload: { current: true, worktree: true }, error: undefined });
      expect(gitReads).toHaveBeenCalledTimes(2);
      gitReads.mockClear();
    }
    const params = { projectId: project.id, agentId: "main" };
    expect(await invoke("projects.checkoutOptions", params, cfg, ["operator.read"])).toMatchObject({
      ok: true,
      payload: { current: false, worktree: false },
    });
    let authorityChecks = 0;
    expect(
      await invoke(
        "projects.checkoutOptions",
        params,
        cfg,
        ["operator.admin"],
        undefined,
        projectsHandlers,
        undefined,
        () => cfg,
        { hasCurrentClientAuthority: () => ++authorityChecks === 1 },
      ),
    ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });
});

test("projects.list exposes a normalized configured default repository", async () => {
  const config = {
    gateway: {
      github: { host: "ghe.example.test" },
      projects: {
        defaultRepository: {
          url: "https://ghe.example.test/Acme/Private-Repo.git",
          ref: "main",
        },
      },
    },
    cloudWorkers: { projectProfiles: { "ghe.example.test/acme/private-repo": "example-azure" } },
  };

  expect(await listProjects(config)).toMatchObject({
    ok: true,
    payload: {
      defaultRepository: {
        identity: "acme/private-repo",
        url: "https://ghe.example.test/acme/private-repo.git",
        ref: "main",
        profileId: "example-azure",
      },
    },
  });
  const readOnly = await listProjects(config, { scopes: ["operator.read"] });
  expect(readOnly?.payload).not.toHaveProperty("defaultRepository");
  expect(
    await listProjects(config, { scopes: ["operator.read", "operator.sessions.write"] }),
  ).toMatchObject({
    ok: true,
    payload: { defaultRepository: { identity: "acme/private-repo" } },
  });
});

test("projects.list refuses a default repository from a replaced config during registry lookup", async () => {
  const original = {
    gateway: {
      github: { host: "ghe.example.test" },
      projects: { defaultRepository: { url: "https://ghe.example.test/acme/private-repo.git" } },
    },
  };
  let current: OpenClawConfig = original;
  using _ = vi
    .spyOn(await import("../../projects/project-registry.js"), "listProjectRegistry")
    .mockImplementation(async () => {
      current = { gateway: { github: { host: "github.com" } } };
      return [];
    });
  expectProjectAccessChanged(await listProjects(original, { getConfig: () => current }));
});

test("projects.list replies before cold or stale observed Git discovery settles", async () => {
  await withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    seedProjectSession("observed", repo);
    const cfg = projectConfig(state.workspaceDir);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    using _ = { [Symbol.dispose]: () => projection.dispose() };
    const list = () =>
      listProjects(cfg, { observed: true, handlers: registeredProjectsHandlers, projection });
    const held =
      Promise.withResolvers<
        Awaited<ReturnType<typeof managedWorktrees.resolveRepositoryIdentities>>
      >();
    const run = gitWorker.runGitWorkerOperation;
    using discovery = vi
      .spyOn(gitWorker, "runGitWorkerOperation")
      .mockImplementation((operation, options) =>
        operation.type === "repository.identities" ? held.promise : run(operation, options),
      );
    try {
      expect(await list()).toMatchObject({ ok: true, payload: { observedProjects: [] } });
      expect(await list()).toMatchObject({ ok: true, payload: { observedProjects: [] } });
      held.resolve([
        {
          checkoutRoot: repo,
          repoRoot: repo,
          originUrl: "https://example.test/repo.git",
          fingerprint: "repo",
        },
      ]);
      await held.promise;
      expect(await list()).toMatchObject({
        ok: true,
        payload: {
          observedProjects: [{ name: "registered", originUrl: "https://example.test/repo.git" }],
        },
      });
      using clock = vi.spyOn(performance, "now");
      clock.mockReturnValue(performance.now() + 60_001);
      const refresh = Promise.withResolvers<Awaited<typeof held.promise>>();
      discovery.mockImplementation((operation, options) =>
        operation.type === "repository.identities" ? refresh.promise : run(operation, options),
      );
      try {
        expect(await list()).toMatchObject({
          ok: true,
          payload: { observedProjects: [{ originUrl: "https://example.test/repo.git" }] },
        });
      } finally {
        refresh.resolve([]);
        await refresh.promise;
      }
      expect(await list()).toMatchObject({ ok: true, payload: { observedProjects: [] } });
    } finally {
      held.resolve([]);
    }
  });
});

test("projects.searchRemote redacts unexpected error diagnostics", async () => {
  using _ = vi
    .spyOn(projectGitHubSearch, "searchRemoteProjects")
    .mockRejectedValue(new Error("GitHub request failed with token=synthetic-secret"));
  const result = await invoke("projects.searchRemote", { query: "openclaw" });
  expect(result).toEqual({
    ok: false,
    payload: undefined,
    error: {
      code: "UNAVAILABLE",
      message: "GitHub project search is unavailable. Retry shortly.",
      retryable: true,
    },
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});

test("projects.list exposes checkout details only at write scope", async () => {
  return withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    await registerProjectRegistry({ path: repo, name: "Registered" });
    const cfg = projectConfig("/workspace/alpha");

    const readResult = await listProjects(cfg, { scopes: ["operator.read"] });
    if (!readResult) {
      throw new Error("projects.list did not respond");
    }
    const readProjects = (readResult.payload as { projects: Record<string, unknown>[] }).projects;
    expect(readProjects).toEqual([
      { id: "workspace:main", displayName: "alpha", source: "workspace", agentId: "main" },
      { id: "registered", displayName: "Registered", source: "registered" },
    ]);
    expect(readResult.payload).not.toHaveProperty("observedProjects");
    expect(readResult.payload).not.toHaveProperty("githubHost");
    expect(listRegistryRecords).not.toHaveBeenCalled();
    expect(resolveRepositoryIdentity).not.toHaveBeenCalled();

    const readOptIn = await listProjects(cfg, { observed: true, scopes: ["operator.read"] });
    expect(readOptIn?.payload).not.toHaveProperty("observedProjects");
    expect(listRegistryRecords).not.toHaveBeenCalled();

    for (const scope of ["operator.write", "operator.admin"]) {
      const callsBeforeDefaultList = listRegistryRecords.mock.calls.length;
      const writeResult = await listProjects(cfg, { scopes: [scope] });
      expect(writeResult).toMatchObject({
        ok: true,
        payload: {
          projects: [
            { id: "workspace:main", repoRoot: "/workspace/alpha" },
            {
              id: "registered",
              repoRoot: repo,
              originUrl: "https://github.com/openclaw/openclaw.git",
            },
          ],
        },
      });
      expect(writeResult?.payload).not.toHaveProperty("observedProjects");
      expect(listRegistryRecords).toHaveBeenCalledTimes(callsBeforeDefaultList);

      const observedResult = await listProjects(cfg, { observed: true, scopes: [scope] });
      expect(observedResult).toMatchObject({
        ok: true,
        payload: { observedProjects: [] },
      });
    }
    expect(listRegistryRecords).toHaveBeenCalledTimes(2);
  });
});

test("project responses redact credentials and URL suffixes from registered origins", async () => {
  return withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    await execFileAsync("git", [
      "-C",
      repo,
      "remote",
      "set-url",
      "origin",
      ["https://user", ":placeholder", "@host/private.git?visible=value#branch"].join(""),
    ]);

    const registered = await invoke("projects.register", { path: repo, name: "Private" }, {}, [
      "operator.admin",
    ]);
    expect(registered).toMatchObject({
      ok: true,
      payload: { originUrl: "https://host/private.git" },
    });

    const listed = await listProjects();
    expect(listed).toMatchObject({
      ok: true,
      payload: {
        projects: expect.arrayContaining([
          expect.objectContaining({ id: "workspace:main" }),
          expect.objectContaining({ id: "private", originUrl: "https://host/private.git" }),
        ]),
      },
    });
  });
});

test("registered projects.list serves current session metadata without broad reads or display refresh", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-worker-" });
  let projection: SessionRowProjection | undefined;
  try {
    const repo = await initializeRepository(state.root);
    const profile = ensureProfileForEmail("projects-worker@example.test");
    const cfg = projectConfig(state.workspaceDir);
    const session = {
      spawnedCwd: repo,
      createdActor: { type: "human", source: "profile", id: profile.id },
    } as const;
    seedProjectSession("project-worker", repo, { ...session, updatedAt: 20 });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const observer = observeSqliteReadSql(prototype);
    const rowQueries = () => observer.queries.filter((sql) => /session_nodes/i.test(sql));
    try {
      loadCombinedSessionStoreForGatewayCore(cfg);
      expect(rowQueries().length).toBeGreaterThan(0);
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      do {
        await projection.ensureMaterialized();
      } while (projection.needsMaterialization);
      const discovered = await managedWorktrees.resolveRepositoryIdentity(repo);
      using identities = vi.spyOn(managedWorktrees, "resolveRepositoryIdentities");
      identities.mockResolvedValue([discovered]);
      observer.queries.length = 0;
      using broadRead = vi
        .spyOn(combinedStoreRead, "loadCombinedSessionStoreForGatewayCoreAsync")
        .mockRejectedValue(new Error("Broad session discovery is unavailable"));
      using _ = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation(() => {
        throw new Error("Session display refresh is unavailable");
      });
      using ownership = vi.spyOn(runtimeOwnership, "readSessionRuntimeOwnershipAsync");
      ownership.mockRejectedValue(new Error("Session runtime ownership is unavailable"));
      sessionChanges.emit({ all: true, scope: "catalog" });
      for (let round = 0; round < 2; round++) {
        if (round === 1) {
          seedProjectSession("project-worker", repo, { ...session, updatedAt: 40, archivedAt: 1 });
          observer.queries.length = 0;
        }
        expect(
          await listProjects(cfg, {
            observed: true,
            profileId: profile.id,
            handlers: registeredProjectsHandlers,
            projection,
          }),
        ).toMatchObject({
          ok: true,
          payload: {
            recents: [{ kind: "folder", folder: repo, displayName: "registered" }],
            observedProjects: [
              { checkouts: [{ runnerId: "gateway", path: repo }], lastUsedAt: round ? 40 : 20 },
            ],
          },
        });
        expect(rowQueries()).toEqual([]);
      }
      expect(broadRead).not.toHaveBeenCalled();
    } finally {
      observer.restore();
    }
  } finally {
    projection?.dispose();
    await state.cleanup();
  }
});

test.each(["unrelated creation", "activity", "visibility", "replacement"])(
  "projects.list revalidates contributing sessions after %s during discovery",
  async (change) => {
    await withProjectState(async (state) => {
      const profile = ensureProfileForEmail("projects-churn@example.test");
      const cfg = projectConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(cfg);
      seedProjectSession("listed-project", "/projects/listed", {
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      using _ = { [Symbol.dispose]: onSessionIdentityMutation(bumpGatewayAccessRevision) };
      resolveRepositoryIdentity.mockImplementationOnce(async (checkoutPath) => {
        if (change === "unrelated creation") {
          seedProjectSession("unrelated", "/projects/unrelated", { updatedAt: 2 });
        } else {
          await patchSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:listed-project" },
            () =>
              change === "visibility"
                ? { visibility: "draft" }
                : change === "replacement"
                  ? { sessionId: "replacement" }
                  : { updatedAt: 2, title: "Active session" },
          );
        }
        return discoverRepository(checkoutPath);
      });
      const result = await listProjects(cfg, { observed: true, profileId: profile.id });
      if (change !== "unrelated creation" && change !== "activity") {
        expectProjectAccessChanged(result);
        return;
      }
      expect(result).toMatchObject({
        ok: true,
        payload: {
          recents: [{ kind: "folder", folder: "/projects/listed" }],
          observedProjects: [
            { name: "listed", checkouts: [{ runnerId: "gateway", path: "/projects/listed" }] },
          ],
        },
      });
    });
  },
);

test.each(["write scope", "session access", "registry access", "probe access"])(
  "projects.list rechecks scopes and tolerates unrelated %s invalidation",
  async (change) => {
    await withProjectState(async (state) => {
      const profile = ensureProfileForEmail("projects-scope@example.test");
      const cfg = projectConfig(state.workspaceDir);
      seedProjectSession("scope", "/private/project", {
        spawnedCwd: "/private/project",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const scopes = ["operator.write"];
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      using _ = { [Symbol.dispose]: () => projection.dispose() };
      const read = projection.prepareSelection;
      using observer = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementation(async (...args) => {
          const result = await read(...args);
          if (change === "write scope") {
            scopes.splice(0, scopes.length, "operator.read");
          } else if (change === "session access") {
            bumpGatewayAccessRevision();
          }
          return result;
        });
      if (change === "probe access") {
        resolveRepositoryIdentity.mockImplementationOnce(async (checkoutPath) => {
          bumpGatewayAccessRevision();
          return discoverRepository(checkoutPath);
        });
      }
      if (change === "registry access") {
        listRegistryRecords.mockImplementationOnce(async () => {
          bumpGatewayAccessRevision();
          return [];
        });
      }
      const result = await listProjects(cfg, {
        observed: true,
        scopes,
        profileId: profile.id,
        projection,
        handlers:
          change === "probe access" || change === "registry access"
            ? projectsHandlers
            : registeredProjectsHandlers,
      });
      if (change !== "write scope") {
        expect(result).toMatchObject({
          ok: true,
          payload: { recents: [{ kind: "folder", folder: "/private/project" }] },
        });
        return;
      }
      expect(result).toEqual({
        ok: true,
        payload: {
          projects: [
            {
              id: "workspace:main",
              displayName: path.basename(state.workspaceDir),
              source: "workspace",
              agentId: "main",
            },
          ],
          recents: [],
        },
        error: undefined,
      });
      expect(observer).toHaveBeenCalled();
    });
  },
);

test("projects.remove returns INVALID_REQUEST for an unknown id", async () => {
  return withProjectState(async () => {
    expect(await invoke("projects.remove", { id: "missing" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "unknown project id: missing" },
    });
  });
});

test("projects.add returns an existing project for the same canonical remote", async () => {
  return withProjectState(async (state) => {
    const repo = await initializeRepository(
      state.root,
      "existing",
      "git@github.com:OpenClaw/OpenClaw.git",
    );
    const existing = await registerProjectRegistry({ path: repo, name: "Existing" });

    expect(
      await invoke("projects.add", {
        gitUrl: "https://github.com/openclaw/openclaw.git",
      }),
    ).toEqual({ ok: true, payload: existing, error: undefined });
  });
});

test("projects.add returns a typed invalid-url failure", async () => {
  return withProjectState(async () => {
    expect(await invoke("projects.add", { gitUrl: "file:///tmp/repo.git" })).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "PROJECT_CLONE_FAILED", cause: "invalid_url" },
      },
    });
  });
});

test.each([
  ["managed", "Managed", "live-worktree"],
  ["workspace-project", "Workspace project", "agent workspace"],
  ["session-root", "Session root", "session"],
  ["session-child", "Session child", "session"],
])(
  "projects.remove preserves a checkout referenced by %s",
  async (name, displayName, reference) => {
    await withProjectState(async (state) => {
      const { repo, project, fingerprint } = await clonedProject(state, name, displayName);
      if (reference === "live-worktree") {
        await insertRegistryWorktree(
          process.env,
          makeWorktreeRecord(repo, reference, {
            repoFingerprint: fingerprint,
            path: path.join(state.stateDir, "worktrees", fingerprint, reference),
            branch: `openclaw/${reference}`,
            baseRef: "main",
            ownerId: "agent:main:session",
          }),
          { provisionedPaths: [] },
        );
      }
      if (reference === "session") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:checkout" },
          {
            sessionId: "checkout",
            updatedAt: 1,
            spawnedCwd: name === "session-child" ? path.join(repo, "src") : repo,
          },
        );
      }
      const cfg = reference === "agent workspace" ? projectConfig(repo) : {};
      await expectCheckoutInUse(repo, project.id, cfg, reference);
    });
  },
);

test("projects.remove preserves a cloned checkout while a duplicate registry row remains", async () => {
  return withProjectState(async (state) => {
    const { repo, project, originUrl } = await clonedProject(
      state,
      "shared-managed",
      "Shared managed",
    );
    const now = Date.now();
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO projects
          (id, display_name, repo_root, origin_url, source, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("shared-managed-copy", "Shared managed copy", repo, null, "registered", now, now);

    expect(await invoke("projects.remove", { id: project.id, deleteCheckout: true })).toMatchObject(
      { ok: true, payload: { removed: true } },
    );
    await expect(fs.stat(repo)).resolves.toBeDefined();

    const listed = await listProjects();
    const survivor = (
      listed?.payload as { projects?: Array<Record<string, unknown>> } | undefined
    )?.projects?.find((candidate) => candidate.id === "shared-managed-copy");
    expect(survivor).toMatchObject({
      id: "shared-managed-copy",
      repoRoot: repo,
      originUrl,
      source: "cloned",
    });

    expect(
      await invoke("projects.remove", {
        id: "shared-managed-copy",
        deleteCheckout: true,
      }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
