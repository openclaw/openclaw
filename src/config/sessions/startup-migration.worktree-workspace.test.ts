import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import * as projectRegistry from "../../projects/project-registry.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
} from "../../projects/project-registry.kernel.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "./worktree-workspace-migration.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("backfills a nested requested workspace once instead of using the agent default", async () => {
  const root = tempDirs.make("openclaw-worktree-workspace-migration-");
  const stateDir = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const agentWorkspace = path.join(repoRoot, "agent-default");
  const requestedWorkspace = path.join(repoRoot, "packages", "app");
  const worktreeRoot = path.join(stateDir, "worktrees", "legacy");
  const spawnedCwd = path.join(worktreeRoot, "packages", "app");
  await Promise.all([
    fs.mkdir(agentWorkspace, { recursive: true }),
    fs.mkdir(requestedWorkspace, { recursive: true }),
    fs.mkdir(spawnedCwd, { recursive: true }),
  ]);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:dashboard:legacy-worktree";
  const ordinarySessionKey = "agent:main:dashboard:ordinary";
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace: agentWorkspace }] },
    session: { store: storePath },
  };
  insertRegistryWorktree(env, {
    id: "legacy",
    name: "legacy",
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: worktreeRoot,
    branch: "openclaw/legacy",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  });
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey, storePath },
    {
      sessionId: "legacy-session",
      updatedAt: 10,
      spawnedCwd,
      worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot },
    },
  );
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey: ordinarySessionKey, storePath },
    { sessionId: "ordinary-session", updatedAt: 20 },
  );
  const ordinaryBefore = loadSessionEntry({
    agentId: "main",
    env,
    sessionKey: ordinarySessionKey,
    storePath,
  });

  const runMigration = async () =>
    await migrateManagedWorktreeCanonicalWorkspaces({
      agentId: "main",
      cfg,
      env,
      storePath,
      mode: "doctor-fix",
    });

  await runMigration();
  const first = loadSessionEntry({ agentId: "main", env, sessionKey, storePath });
  expect(first?.worktree?.canonicalWorkspaceDir).toBe(requestedWorkspace);
  expect(first?.updatedAt).toBe(10);

  await runMigration();
  expect(loadSessionEntry({ agentId: "main", env, sessionKey, storePath })).toEqual(first);
  expect(
    loadSessionEntry({ agentId: "main", env, sessionKey: ordinarySessionKey, storePath }),
  ).toEqual(ordinaryBefore);
});

it("repairs a foreign logical row in its source partition without changing a same-key sibling", async () => {
  const root = tempDirs.make("openclaw-worktree-source-partition-");
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "shared.json");
  const workspace = path.join(root, "ops-workspace");
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, ops: { workspace } },
      defaults: { sessionStore: { agentId: "main" } },
    },
    session: { store: storePath },
  };
  await fs.mkdir(workspace, { recursive: true });
  await replaceSessionEntry(
    { agentId: "main", env, sessionKey: "agent:main:ordinary", storePath },
    { sessionId: "ordinary-session", updatedAt: 5 },
  );
  const sourcePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
    env,
  }).path;
  const scope = { agentId: "ops", env, sessionKey: "agent:ops:legacy-worktree", storePath };
  const sourceScope = { ...scope, storePath: sourcePath };
  await replaceSessionEntry(sourceScope, {
    sessionId: "source-session",
    updatedAt: 10,
    worktree: { id: "legacy", branch: "openclaw/legacy", repoRoot: workspace },
  });
  await replaceSessionEntry(scope, {
    sessionId: "sibling-session",
    updatedAt: 20,
    worktree: {
      id: "legacy",
      branch: "openclaw/legacy",
      repoRoot: path.join(root, "unrelated-workspace"),
    },
  });
  const siblingBefore = loadSessionEntry(scope);
  const runMigration = () =>
    migrateManagedWorktreeCanonicalWorkspaces({
      agentId: "main",
      cfg,
      env,
      storePath,
      mode: "doctor-fix",
    });

  await expect(runMigration()).resolves.toEqual({ found: 1, repaired: 1 });
  expect(loadSessionEntry(sourceScope)).toMatchObject({
    sessionId: "source-session",
    updatedAt: 10,
    worktree: {
      id: "legacy",
      branch: "openclaw/legacy",
      repoRoot: workspace,
      canonicalWorkspaceDir: workspace,
    },
  });
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
  await expect(runMigration()).resolves.toEqual({ found: 0, repaired: 0 });
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
});

it.each(["main", "ops"])(
  "backfills each logical owner's workspace in a shared SQLite store selected for %s",
  async (agentId) => {
    const root = tempDirs.make("openclaw-shared-worktree-workspace-migration-");
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = path.join(stateDir, "shared.sqlite");
    const agents = ["main", "ops"].map((id) => ({ id, workspace: path.join(root, id) }));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(agents.map(({ id, workspace }) => [id, { workspace }])),
        defaults: { sessionStore: { agentId: "main" } },
      },
      session: { store: storePath },
    };
    // Stage persisted legacy rows without a runtime write pruning the previous old row.
    for (const agent of agents) {
      await fs.mkdir(agent.workspace, { recursive: true });
      replaceSessionEntrySync(
        { agentId: agent.id, env, sessionKey: `agent:${agent.id}:worktree`, storePath },
        {
          sessionId: `${agent.id}-session`,
          updatedAt: 10,
          worktree: { id: agent.id, branch: `openclaw/${agent.id}`, repoRoot: agent.workspace },
        },
      );
    }

    const readEntries = () =>
      agents.map((agent) =>
        loadSessionEntry({
          agentId: agent.id,
          env,
          sessionKey: `agent:${agent.id}:worktree`,
          storePath,
        }),
      );
    expect(readEntries().map((entry) => entry?.sessionId)).toEqual(
      agents.map((agent) => `${agent.id}-session`),
    );
    const runMigration = () =>
      migrateManagedWorktreeCanonicalWorkspaces({
        agentId,
        cfg,
        env,
        storePath,
        mode: "doctor-fix",
      });
    await expect(runMigration()).resolves.toEqual({ found: 2, repaired: 2 });
    const migrated = readEntries();
    expect(migrated).toEqual(
      agents.map((agent) =>
        expect.objectContaining({
          sessionId: `${agent.id}-session`,
          updatedAt: 10,
          worktree: {
            id: agent.id,
            branch: `openclaw/${agent.id}`,
            repoRoot: agent.workspace,
            canonicalWorkspaceDir: agent.workspace,
          },
        }),
      ),
    );
    await expect(runMigration()).resolves.toEqual({ found: 0, repaired: 0 });
    expect(readEntries()).toEqual(migrated);
  },
);

async function createRegisteredProjectMigrationFixture() {
  const root = tempDirs.make("openclaw-registered-worktree-workspace-migration-");
  const stateDir = path.join(root, "state");
  const repoRoot = path.join(root, "registered-project");
  const otherRepoRoot = path.join(root, "other-project");
  const agentWorkspace = path.join(root, "agent-default");
  const worktreeRoot = path.join(stateDir, "worktrees", "legacy-project");
  const spawnedCwd = path.join(worktreeRoot, "packages", "app");
  const otherSpawnedCwd = path.join(worktreeRoot, "packages", "other");
  await Promise.all(
    [repoRoot, otherRepoRoot, agentWorkspace, spawnedCwd, otherSpawnedCwd].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = "agent:main:dashboard:legacy-project-worktree";
  const scope = { agentId: "main", env, sessionKey, storePath };
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace: agentWorkspace }] },
    session: { store: storePath },
  };
  // Persisted legacy setup only: public project registration separately validates Git.
  ensureProjectRegistrySchema({ env });
  const { project, otherProject } = runOpenClawStateWriteTransaction(
    ({ db }) => ({
      project: insertProjectRegistryInDatabase(db, {
        displayName: "Registered project",
        repoRoot,
        source: "registered",
      }),
      otherProject: insertProjectRegistryInDatabase(db, {
        displayName: "Other project",
        repoRoot: otherRepoRoot,
        source: "registered",
      }),
    }),
    { env },
  );
  insertRegistryWorktree(env, {
    id: "legacy-project",
    name: "legacy-project",
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: worktreeRoot,
    branch: "openclaw/legacy-project",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  });
  const entry = {
    sessionId: "legacy-project-session",
    updatedAt: 10,
    projectId: project.id,
    spawnedCwd,
    worktree: { id: "legacy-project", branch: "openclaw/legacy-project", repoRoot },
  };
  replaceSessionEntrySync(scope, entry);
  return {
    scope,
    entry,
    project,
    otherProject,
    otherRepoRoot,
    otherSpawnedCwd,
    runMigration: () =>
      migrateManagedWorktreeCanonicalWorkspaces({
        agentId: "main",
        cfg,
        env,
        storePath,
        mode: "doctor-fix",
      }),
  };
}

it("backfills the persisted project workspace through the resolver once", async () => {
  const fixture = await createRegisteredProjectMigrationFixture();
  const before = loadSessionEntry(fixture.scope);

  await expect(fixture.runMigration()).resolves.toEqual({ found: 1, repaired: 1 });
  const migrated = loadSessionEntry(fixture.scope);
  expect(migrated).toEqual({
    ...before,
    worktree: { ...before?.worktree, canonicalWorkspaceDir: fixture.project.repoRoot },
  });
  expect(migrated?.updatedAt).toBe(10);
  await expect(fixture.runMigration()).resolves.toEqual({ found: 0, repaired: 0 });
  expect(loadSessionEntry(fixture.scope)).toEqual(migrated);
});

it.each(["projectId", "repoRoot", "spawnedCwd"] as const)(
  "preserves the changed source row when %s changes after project resolution",
  async (field) => {
    const fixture = await createRegisteredProjectMigrationFixture();
    const replacement = {
      ...fixture.entry,
      projectId: field === "projectId" ? fixture.otherProject.id : fixture.entry.projectId,
      spawnedCwd: field === "spawnedCwd" ? fixture.otherSpawnedCwd : fixture.entry.spawnedCwd,
      worktree: {
        ...fixture.entry.worktree,
        repoRoot: field === "repoRoot" ? fixture.otherRepoRoot : fixture.entry.worktree.repoRoot,
      },
    };
    let beforeMigrationPatch: ReturnType<typeof loadSessionEntry>;
    const resolve = projectRegistry.resolveProjectRegistry;
    const wrappedResolve = vi
      .spyOn(projectRegistry, "resolveProjectRegistry")
      .mockImplementationOnce(async (...args) => {
        const project = await resolve(...args);
        expect(project?.id).toBe(fixture.project.id);
        replaceSessionEntrySync(fixture.scope, replacement);
        beforeMigrationPatch = loadSessionEntry(fixture.scope);
        return project;
      });

    await expect(fixture.runMigration()).resolves.toEqual({ found: 1, repaired: 0 });
    expect(wrappedResolve).toHaveBeenCalledOnce();
    expect(beforeMigrationPatch).toMatchObject(replacement);
    expect(loadSessionEntry(fixture.scope)).toEqual(beforeMigrationPatch);
    expect(loadSessionEntry(fixture.scope)?.worktree?.canonicalWorkspaceDir).toBeUndefined();
  },
);
