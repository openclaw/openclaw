import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as githubReadIdentity from "../../agents/github-read-identity.js";
import * as runtimeOwnership from "../../agents/harness/session-runtime-ownership.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import * as gitWorker from "../../infra/git-worker.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
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
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import {
  execFileAsync,
  initializeRepository,
  invokeProjectMethod,
  listRegistryRecords,
  projectsHandlers,
  resolveRepositoryIdentity,
  withProjectState,
} from "./projects.test-support.js";

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
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  const github = { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" };
  const boundConfig = {
    gateway: {
      github,
      controlUi: { github: { host: "ghe.example.test", token: "enterprise-service-token" } },
    },
  };
  setRuntimeConfigSnapshot(boundConfig);

  expect(
    await invokeProjectMethod(
      "projects.searchRemote",
      { query: "enterprise-bound-request" },
      boundConfig,
    ),
  ).toMatchObject({ ok: true, payload: { credential: "configured" } });
  expect(fetchImpl).toHaveBeenCalled();
  for (const [url, init] of fetchImpl.mock.calls) {
    expect(url).toMatch(/^https:\/\/ghe\.example\.test\/api\/v3\//u);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer enterprise-service-token");
  }

  fetchImpl.mockClear();
  const mismatchedConfig = {
    gateway: { github, controlUi: { github: { token: "public-service-token" } } },
  };
  setRuntimeConfigSnapshot(mismatchedConfig);
  expect(
    await invokeProjectMethod(
      "projects.searchRemote",
      { query: "enterprise-mismatched-request" },
      mismatchedConfig,
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("host binding") },
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("projects.searchRemote binds native tokens to the host through final fetch", async () => {
  const cfg = {
    tools: { github: { profileId: "ghp_11111111111111111111111111111111" } },
    agents: {
      entries: {
        main: { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } },
      },
    },
    gateway: {
      github: { host: "a.ghe.example.test", apiBaseUrl: "https://a.ghe.example.test/api/v3" },
      projects: { nativeGitHubSearch: true },
    },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  setRuntimeConfigSnapshot(cfg);
  const native = vi
    .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
    .mockResolvedValue("host-a-token");
  try {
    expect(
      await invokeProjectMethod("projects.searchRemote", { query: "host-a-allowed" }, cfg),
    ).toMatchObject({ ok: true, payload: { credential: "configured" } });
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toMatch(/^https:\/\/a\.ghe\.example\.test\/api\/v3\//u);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer host-a-token");
    }

    fetchImpl.mockClear();
    native.mockImplementation(async () => {
      setRuntimeConfigSnapshot({
        gateway: {
          github: { host: "b.ghe.example.test", apiBaseUrl: "https://b.ghe.example.test/api/v3" },
        },
      });
      return "host-a-token";
    });
    expect(
      await invokeProjectMethod("projects.searchRemote", { query: "host-a-replaced" }, cfg),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("GitHub host changed") },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    native.mockRestore();
  }
});

test.each(["revoked", "aborted"] as const)(
  "registered projects.searchRemote refuses %s callers before credentialed I/O",
  async (closed) => {
    const cfg = {
      gateway: {
        github: { host: "a.ghe.example.test", apiBaseUrl: "https://a.ghe.example.test/api/v3" },
        projects: { nativeGitHubSearch: true },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const controller = new AbortController();
    let active = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const native = vi
      .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
      .mockImplementation(async () => {
        if (closed === "aborted") {
          controller.abort();
        } else {
          active = false;
        }
        return "synthetic-host-a-token";
      });
    try {
      const result = await invokeProjectMethod(
        "projects.searchRemote",
        { query: `closed-native-${closed}` },
        cfg,
        ["operator.write"],
        undefined,
        registeredProjectsHandlers,
        undefined,
        () => cfg,
        { signal: controller.signal, hasCurrentClientAuthority: () => active },
      );
      expect(result).toMatchObject({ ok: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      native.mockRestore();
    }
  },
);

test("registered project search keeps an ambient Enterprise token at its declared host", async () => {
  const config = (host: string) => ({
    gateway: {
      github: { host, apiBaseUrl: `https://${host}/api/v3` },
      projects: { nativeGitHubSearch: true },
    },
  });
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "synthetic-host-a-ambient-token");
  vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "");
  vi.stubEnv("GH_HOST", "a.ghe.example.test");
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  const allowed = config("a.ghe.example.test");
  setRuntimeConfigSnapshot(allowed);
  expect(
    await invokeProjectMethod(
      "projects.searchRemote",
      { query: "ambient-allowed" },
      allowed,
      ["operator.write"],
      undefined,
      registeredProjectsHandlers,
    ),
  ).toMatchObject({ ok: true });
  expect(fetchImpl).toHaveBeenCalled();
  for (const [url, init] of fetchImpl.mock.calls) {
    expect(url).toMatch(/^https:\/\/a\.ghe\.example\.test\//);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer synthetic-host-a-ambient-token",
    );
  }
  fetchImpl.mockClear();
  const forbidden = config("b.ghe.example.test");
  setRuntimeConfigSnapshot(forbidden);
  expect(
    await invokeProjectMethod(
      "projects.searchRemote",
      { query: "ambient-forbidden" },
      forbidden,
      ["operator.write"],
      undefined,
      registeredProjectsHandlers,
    ),
  ).toMatchObject({ ok: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("registered anonymous native search does not borrow the service credential", async () => {
  const native = vi
    .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
    .mockResolvedValue(undefined);
  const cfg = {
    gateway: {
      github: { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" },
      controlUi: { github: { host: "tenant.ghe.com", token: "synthetic-service-token" } },
      projects: { nativeGitHubSearch: true },
    },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchImpl);
  setRuntimeConfigSnapshot(cfg);
  try {
    expect(
      await invokeProjectMethod(
        "projects.searchRemote",
        { query: "anonymous-tenant" },
        cfg,
        ["operator.write"],
        undefined,
        registeredProjectsHandlers,
      ),
    ).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalled();
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    }
  } finally {
    native.mockRestore();
  }
});

test("checkout options preserve permitted Current access without exposing paths", async () => {
  await withProjectState(async (state) => {
    const workspace = await initializeRepository(state.root, "workspace");
    const outside = await initializeRepository(state.root, "outside");
    const project = await registerProjectRegistry({ path: outside });
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace, sandbox: { mode: "off" } } } },
    };
    for (const scopes of [
      ["operator.admin"],
      ["operator.sessions.read", "operator.sessions.write"],
    ]) {
      expect(
        await invokeProjectMethod(
          "projects.checkoutOptions",
          { projectId: project.id, agentId: "main" },
          cfg,
          scopes,
        ),
      ).toEqual({ ok: true, payload: { current: true, worktree: true }, error: undefined });
    }
    const params = { projectId: project.id, agentId: "main" };
    expect(
      await invokeProjectMethod("projects.checkoutOptions", params, cfg, ["operator.read"]),
    ).toMatchObject({ ok: true, payload: { current: false, worktree: false } });
    let authorityChecks = 0;
    expect(
      await invokeProjectMethod(
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

  expect(await invokeProjectMethod("projects.list", {}, config)).toMatchObject({
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
  const readOnly = await invokeProjectMethod("projects.list", {}, config, ["operator.read"]);
  expect(readOnly?.payload).not.toHaveProperty("defaultRepository");
  expect(
    await invokeProjectMethod("projects.list", {}, config, [
      "operator.read",
      "operator.sessions.write",
    ]),
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
  const list = vi
    .spyOn(await import("../../projects/project-registry.js"), "listProjectRegistry")
    .mockImplementation(async () => {
      current = { gateway: { github: { host: "github.com" } } };
      return [];
    });
  try {
    expect(
      await invokeProjectMethod(
        "projects.list",
        {},
        original,
        ["operator.write"],
        undefined,
        projectsHandlers,
        undefined,
        () => current,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: expect.stringContaining("Project access changed") },
    });
  } finally {
    list.mockRestore();
  }
});

test("projects.list replies before cold or stale observed Git discovery settles", async () => {
  await withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:observed" },
      { sessionId: "observed", updatedAt: 1, execCwd: repo },
    );
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    using _ = { [Symbol.dispose]: () => projection.dispose() };
    const list = () =>
      invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        ["operator.write"],
        undefined,
        registeredProjectsHandlers,
        projection,
      );
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
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(Date.now() + 60_001);
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
  const search = vi
    .spyOn(projectGitHubSearch, "searchRemoteProjects")
    .mockRejectedValue(new Error("GitHub request failed with token=synthetic-secret"));
  try {
    const result = await invokeProjectMethod("projects.searchRemote", { query: "openclaw" });
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
  } finally {
    search.mockRestore();
  }
});

test("projects.list exposes checkout details only at write scope", async () => {
  return withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    await registerProjectRegistry({ path: repo, name: "Registered" });
    const cfg = {
      agents: {
        entries: { main: { workspace: "/workspace/alpha" } },
      },
    };

    const readResult = await invokeProjectMethod("projects.list", {}, cfg, ["operator.read"]);
    if (!readResult) {
      throw new Error("projects.list did not respond");
    }
    const readProjects = (readResult.payload as { projects: Record<string, unknown>[] }).projects;
    expect(readProjects).toEqual([
      { id: "workspace:main", displayName: "alpha", source: "workspace", agentId: "main" },
      { id: "registered", displayName: "Registered", source: "registered" },
    ]);
    for (const project of readProjects) {
      expect(project).not.toHaveProperty("repoRoot");
      expect(project).not.toHaveProperty("originUrl");
    }
    expect(readResult.payload).not.toHaveProperty("observedProjects");
    expect(readResult.payload).not.toHaveProperty("githubHost");
    expect(listRegistryRecords).not.toHaveBeenCalled();
    expect(resolveRepositoryIdentity).not.toHaveBeenCalled();

    const readOptIn = await invokeProjectMethod("projects.list", { includeObserved: true }, cfg, [
      "operator.read",
    ]);
    expect(readOptIn?.payload).not.toHaveProperty("observedProjects");
    expect(listRegistryRecords).not.toHaveBeenCalled();

    for (const scope of ["operator.write", "operator.admin"]) {
      const callsBeforeDefaultList = listRegistryRecords.mock.calls.length;
      const writeResult = await invokeProjectMethod("projects.list", {}, cfg, [scope]);
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

      const observedResult = await invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        [scope],
      );
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

    const registered = await invokeProjectMethod(
      "projects.register",
      { path: repo, name: "Private" },
      {},
      ["operator.admin"],
    );
    expect(registered).toMatchObject({
      ok: true,
      payload: { originUrl: "https://host/private.git" },
    });

    const listed = await invokeProjectMethod("projects.list", {}, {}, ["operator.write"]);
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
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:project-worker" },
      {
        sessionId: "project-worker",
        updatedAt: 20,
        spawnedCwd: repo,
        execCwd: repo,
        createdActor: { type: "human", source: "profile", id: profile.id },
      },
    );
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
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:project-worker" },
            {
              sessionId: "project-worker",
              updatedAt: 40,
              archivedAt: 1,
              spawnedCwd: repo,
              execCwd: repo,
              createdActor: { type: "human", source: "profile", id: profile.id },
            },
          );
          observer.queries.length = 0;
        }
        expect(
          await invokeProjectMethod(
            "projects.list",
            { includeObserved: true },
            cfg,
            ["operator.write"],
            profile.id,
            registeredProjectsHandlers,
            projection,
          ),
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
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:listed-project" },
        {
          sessionId: "listed-project",
          updatedAt: 1,
          execCwd: "/projects/listed",
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const stop = onSessionIdentityMutation(bumpGatewayAccessRevision);
      resolveRepositoryIdentity.mockImplementationOnce(async (checkoutPath) => {
        if (change === "unrelated creation") {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:unrelated" },
            { sessionId: "unrelated", updatedAt: 2, execCwd: "/projects/unrelated" },
          );
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
        return {
          checkoutRoot: checkoutPath,
          repoRoot: checkoutPath,
          originUrl: "",
          fingerprint: checkoutPath,
        };
      });
      try {
        const result = await invokeProjectMethod(
          "projects.list",
          { includeObserved: true },
          cfg,
          ["operator.write"],
          profile.id,
        );
        if (change !== "unrelated creation" && change !== "activity") {
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: expect.stringContaining("Project access changed"),
            },
          });
          expect(result?.payload).toBeUndefined();
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
      } finally {
        stop();
      }
    });
  },
);

test.each(["write scope", "session access", "registry access", "probe access"])(
  "projects.list rechecks scopes and tolerates unrelated %s invalidation",
  async (change) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "projects-worker-scope-",
    });
    let projection: SessionRowProjection | undefined;
    let restoreRead = () => {};
    try {
      const profile = ensureProfileForEmail("projects-scope@example.test");
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:scope" },
        {
          sessionId: "scope",
          updatedAt: 1,
          spawnedCwd: "/private/project",
          execCwd: "/private/project",
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const scopes = ["operator.write"];
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const read = projection.prepareSelection;
      const observer = vi
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
      restoreRead = () => observer.mockRestore();
      if (change === "probe access") {
        resolveRepositoryIdentity.mockImplementationOnce(async (checkoutPath) => {
          bumpGatewayAccessRevision();
          return {
            checkoutRoot: checkoutPath,
            repoRoot: checkoutPath,
            originUrl: "",
            fingerprint: checkoutPath,
          };
        });
      }
      if (change === "registry access") {
        listRegistryRecords.mockImplementationOnce(async () => {
          bumpGatewayAccessRevision();
          return [];
        });
      }
      const result = await invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        scopes,
        profile.id,
        change === "probe access" || change === "registry access"
          ? projectsHandlers
          : registeredProjectsHandlers,
        projection,
      );
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
    } finally {
      restoreRead();
      projection?.dispose();
      await state.cleanup();
    }
  },
);

test("projects.remove returns INVALID_REQUEST for an unknown id", async () => {
  return withProjectState(async () => {
    expect(await invokeProjectMethod("projects.remove", { id: "missing" })).toMatchObject({
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
      await invokeProjectMethod("projects.add", {
        gitUrl: "https://github.com/openclaw/openclaw.git",
      }),
    ).toEqual({ ok: true, payload: existing, error: undefined });
  });
});

test("projects.add returns a typed invalid-url failure", async () => {
  return withProjectState(async () => {
    expect(
      await invokeProjectMethod("projects.add", { gitUrl: "file:///tmp/repo.git" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "PROJECT_CLONE_FAILED", cause: "invalid_url" },
      },
    });
  });
});

test("projects.remove refuses to delete a cloned checkout referenced by a live worktree", async () => {
  return withProjectState(async (state) => {
    const originUrl = "https://github.com/acme/managed.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "managed",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Managed",
      originUrl,
    });
    await insertRegistryWorktree(
      process.env,
      {
        id: "live-worktree",
        name: "live-worktree",
        repoFingerprint: fingerprint,
        repoRoot: repo,
        path: path.join(state.stateDir, "worktrees", fingerprint, "live-worktree"),
        branch: "openclaw/live-worktree",
        baseRef: "main",
        ownerKind: "session",
        ownerId: "agent:main:session",
        createdAt: 1,
        lastActiveAt: 1,
      },
      { provisionedPaths: [] },
    );

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("live-worktree") },
    });
    await expect(fs.stat(repo)).resolves.toBeDefined();
  });
});

test("projects.remove preserves a cloned checkout while a duplicate registry row remains", async () => {
  return withProjectState(async (state) => {
    const originUrl = "https://github.com/acme/shared-managed.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "shared-managed",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Shared managed",
      originUrl,
    });
    const now = Date.now();
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO projects
          (id, display_name, repo_root, origin_url, source, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("shared-managed-copy", "Shared managed copy", repo, null, "registered", now, now);

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).resolves.toBeDefined();

    const listed = await invokeProjectMethod("projects.list", {}, {}, ["operator.write"]);
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
      await invokeProjectMethod("projects.remove", {
        id: "shared-managed-copy",
        deleteCheckout: true,
      }),
    ).toMatchObject({ ok: true, payload: { removed: true } });
    await expect(fs.stat(repo)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("projects.remove refuses to delete a cloned checkout configured as an agent workspace", async () => {
  return withProjectState(async (state) => {
    const originUrl = "https://github.com/acme/workspace-project.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "workspace-project",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Workspace project",
      originUrl,
    });
    const cfg = {
      agents: { entries: { main: { workspace: repo } } },
    } as OpenClawConfig;

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent workspace") },
    });
    await expect(fs.stat(repo)).resolves.toBeDefined();
  });
});
