import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { beforeEach, expect, test, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
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
  listRegistryRecords.mockClear();
  resolveRepositoryIdentity.mockClear();
});

function withProjectState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" }, run);
}

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
      "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.",
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
