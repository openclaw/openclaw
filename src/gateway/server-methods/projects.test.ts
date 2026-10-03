import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as githubReadIdentity from "../../agents/github-read-identity.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import * as spawnDiagnostics from "../../process/spawn-diagnostics.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { gitHubPublicApi } from "../github-public-api.js";
import * as projectGitHubSearch from "../project-github-search.js";
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import {
  execFileAsync,
  initializeRepository,
  invokeProjectMethod,
  listRegistryRecords,
  projectsHandlers,
  resolveRepositoryIdentity,
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

function withProjectState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" }, run);
}

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

test("projects.searchRemote uses the opted-in native system GitHub identity", async () => {
  const token = vi
    .spyOn(githubReadIdentity, "readCachedNativeGitHubToken")
    .mockResolvedValue("native-system-token");
  const search = vi.spyOn(projectGitHubSearch, "searchRemoteProjects").mockResolvedValue({
    credential: "configured",
    projects: [],
  });
  try {
    expect(
      await invokeProjectMethod(
        "projects.searchRemote",
        { query: "acme/private-repo" },
        { gateway: { projects: { nativeGitHubSearch: true } } },
      ),
    ).toEqual({
      ok: true,
      payload: { credential: "configured", projects: [] },
      error: undefined,
    });
    expect(token).toHaveBeenCalledWith(process.env);
    expect(search).toHaveBeenCalledWith("acme/private-repo", {
      token: "native-system-token",
      assertCurrent: expect.any(Function),
      signal: undefined,
      host: "github.com",
      apiBaseUrl: "https://api.github.com",
    });
  } finally {
    search.mockRestore();
    token.mockRestore();
  }
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

test("projects.list coalesces concurrent observed Git discovery and refreshes later reads", async () => {
  await withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:observed" },
      { sessionId: "observed", updatedAt: 1, execCwd: repo },
    );
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const list = () =>
      invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        ["operator.write"],
        undefined,
        registeredProjectsHandlers,
      );
    using spawns = vi.spyOn(spawnDiagnostics, "recordChildProcessSpawn");
    const single = await list();
    expect(single).toMatchObject({
      ok: true,
      payload: {
        observedProjects: [
          { name: "registered", originUrl: "https://github.com/openclaw/openclaw.git" },
        ],
      },
    });
    const gitSpawns = () =>
      spawns.mock.calls.filter(([command]) =>
        /^git(?:\.exe|\.cmd)?$/i.test(path.win32.basename(command)),
      ).length;
    const onePass = gitSpawns();
    expect(onePass).toBeGreaterThan(0);
    spawns.mockClear();
    const requestCount = 10;
    const admitted = Promise.withResolvers<void>();
    let remaining = requestCount;
    const resolveIdentities = managedWorktrees.resolveRepositoryIdentities.bind(managedWorktrees);
    // SQLite preparation can stagger RPCs past a pending-only Git pass's lifetime.
    using discovery = vi
      .spyOn(managedWorktrees, "resolveRepositoryIdentities")
      .mockImplementation(async (roots) => {
        if (--remaining === 0) {
          admitted.resolve();
        }
        await admitted.promise;
        return resolveIdentities(roots);
      });
    const concurrent = await Promise.all(
      Array.from({ length: requestCount }, () => list().finally(() => admitted.resolve())),
    );
    discovery.mockRestore();
    for (const result of concurrent) {
      expect(result).toEqual(single);
    }
    expect(gitSpawns()).toBeLessThanOrEqual(onePass);
    await execFileAsync("git", [
      "-C",
      repo,
      "remote",
      "set-url",
      "origin",
      "https://example.test/changed.git",
    ]);
    expect(await list()).toMatchObject({
      ok: true,
      payload: { observedProjects: [{ originUrl: "https://example.test/changed.git" }] },
    });
    await fs.rm(repo, { recursive: true });
    expect(await list()).toMatchObject({ ok: true, payload: { observedProjects: [] } });
  });
});

test.each([
  {
    failure: "rate limit",
    error: () =>
      new gitHubPublicApi.ControlUiGitHubError(429, "quota exhausted", {
        upstreamStatus: 403,
        retryAtMs: Date.now() + 30_000,
      }),
    message: "GitHub API rate limit exceeded (HTTP 403). Wait 30 seconds and retry.",
    retryable: true,
    retryAfterMs: 30_000,
  },
  {
    failure: "authentication",
    error: () => new gitHubPublicApi.ControlUiGitHubError(401, "credential rejected"),
    message: "GitHub authentication failed (HTTP 401). Reconnect the GitHub identity in Settings.",
    retryable: false,
  },
  {
    failure: "repository access",
    error: () => new gitHubPublicApi.ControlUiGitHubError(403, "repository denied"),
    message:
      "GitHub access denied (HTTP 403). Check the configured GitHub identity's repository access.",
    retryable: false,
  },
  {
    failure: "unavailable configured credential",
    error: () =>
      new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "synthetic-secret",
      }),
    message:
      "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.",
    retryable: false,
  },
  {
    failure: "unexpected diagnostic",
    error: () => new Error("GitHub request failed with token=synthetic-secret"),
    message: "GitHub project search is unavailable. Retry shortly.",
    retryable: true,
  },
])(
  "projects.searchRemote preserves safe $failure diagnostics and retry metadata",
  async ({ error, message, retryable, retryAfterMs }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const search = vi.spyOn(projectGitHubSearch, "searchRemoteProjects").mockRejectedValue(error());
    try {
      const result = await invokeProjectMethod("projects.searchRemote", { query: "openclaw" });
      expect(result).toEqual({
        ok: false,
        payload: undefined,
        error: {
          code: "UNAVAILABLE",
          message,
          retryable,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    } finally {
      search.mockRestore();
      clock.mockRestore();
    }
  },
);

test("projects.list exposes checkout details only at write scope", async () => {
  return withProjectState(async (state) => {
    const repo = await initializeRepository(state.root);
    await registerProjectRegistry({ path: repo, name: "Registered" });
    const cfg = {
      agents: {
        list: [{ id: "main", default: true, workspace: "/workspace/alpha" }],
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

test("registered projects.list reads recents and observed session rows off the caller thread", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-worker-" });
  try {
    const repo = await initializeRepository(state.root);
    const profile = ensureProfileForEmail("projects-worker@example.test");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: state.workspaceDir }] },
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
      observer.queries.length = 0;
      for (let round = 0; round < 2; round++) {
        expect(
          await invokeProjectMethod(
            "projects.list",
            { includeObserved: true },
            cfg,
            ["operator.write"],
            profile.id,
            registeredProjectsHandlers,
          ),
        ).toMatchObject({
          ok: true,
          payload: {
            recents: [{ kind: "folder", folder: repo, displayName: "registered" }],
            observedProjects: [
              { checkouts: [{ runnerId: "gateway", path: repo }], lastUsedAt: 20 },
            ],
          },
        });
      }
      expect(rowQueries()).toEqual([]);
    } finally {
      observer.restore();
    }
  } finally {
    await state.cleanup();
  }
});

test.each(["write scope", "session access", "registry access", "probe access"])(
  "projects.list rechecks %s after preparation",
  async (change) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "projects-worker-scope-",
    });
    const read = transcriptWorker.withSessionHistoryWorkerDatabases;
    let restoreRead = () => {};
    try {
      const profile = ensureProfileForEmail("projects-scope@example.test");
      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: state.workspaceDir }] },
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
      const observer = vi
        .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
        .mockImplementation(async (options, operation) => {
          const result = await read(options, operation);
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
      );
      if (change !== "write scope") {
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
    insertRegistryWorktree(
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
      agents: { list: [{ id: "main", default: true, workspace: repo }] },
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

test("projects.remove refuses to delete a cloned checkout used by a live direct session", async () => {
  return withProjectState(async (state) => {
    const originUrl = "https://github.com/acme/session-project.git";
    const fingerprint = sha256HexPrefixCore(originUrl, 16);
    const repo = await initializeRepository(
      path.join(state.stateDir, "projects", fingerprint),
      "session-project",
      originUrl,
    );
    const project = await registerClonedProjectRegistry({
      path: repo,
      name: "Session project",
      originUrl,
    });
    await upsertSessionEntryCore(
      { agentId: "main", env: state.env, sessionKey: "agent:main:project-session" },
      { sessionId: "project-session", spawnedCwd: repo, updatedAt: 1 },
    );
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: state.workspaceDir }] },
    } as OpenClawConfig;

    expect(
      await invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("project-session") },
    });
  });
});
