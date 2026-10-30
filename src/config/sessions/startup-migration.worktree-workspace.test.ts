import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import * as worktreeRegistry from "../../agents/worktrees/registry.js";
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

function migration(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  storePath: string,
  agentId = "main",
) {
  return () =>
    migrateManagedWorktreeCanonicalWorkspaces({ agentId, cfg, env, storePath, mode: "doctor-fix" });
}
function worktreeEntry(sessionId: string, repoRoot: string, id = "legacy", updatedAt = 10) {
  return { sessionId, updatedAt, worktree: { id, branch: `openclaw/${id}`, repoRoot } };
}
async function mkdir(...directories: string[]) {
  await Promise.all(directories.map((directory) => fs.mkdir(directory, { recursive: true })));
}
function withWorkspace(entry: ReturnType<typeof loadSessionEntry>, canonicalWorkspaceDir: string) {
  return { ...entry, worktree: { ...entry?.worktree, canonicalWorkspaceDir } };
}
function createFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  const stateDir = path.join(root, "state");
  return { root, stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

async function createManagedFixture(id: string) {
  const { root, stateDir, env } = createFixture(`openclaw-${id}-workspace-`);
  const repoRoot = path.join(root, "repo");
  const agentWorkspace = path.join(root, "agent-default");
  const requestedWorkspace = path.join(repoRoot, "packages", "app");
  const worktreeRoot = path.join(stateDir, "worktrees", id);
  const spawnedCwd = path.join(worktreeRoot, "packages", "app");
  await mkdir(agentWorkspace, requestedWorkspace, spawnedCwd);
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionKey = `agent:main:dashboard:${id}`;
  const scope = { agentId: "main", env, sessionKey, storePath };
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: agentWorkspace } } },
    session: { store: storePath },
  };
  await insertRegistryWorktree(env, {
    id,
    name: id,
    repoFingerprint: "0123456789abcdef",
    repoRoot,
    path: worktreeRoot,
    branch: `openclaw/${id}`,
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  });
  const entry = { ...worktreeEntry(`${id}-session`, repoRoot, id), spawnedCwd };
  return {
    root,
    env,
    repoRoot,
    worktreeRoot,
    scope,
    entry,
    requestedWorkspace,
    runMigration: migration(cfg, env, storePath),
  };
}

it("backfills a nested requested workspace once instead of using the agent default", async () => {
  const { scope, entry, requestedWorkspace, runMigration } = await createManagedFixture("legacy");
  const ordinaryScope = { ...scope, sessionKey: "agent:main:dashboard:ordinary" };
  await replaceSessionEntry(scope, entry);
  await replaceSessionEntry(ordinaryScope, { sessionId: "ordinary-session", updatedAt: 20 });
  const ordinaryBefore = loadSessionEntry(ordinaryScope);
  await runMigration();
  const first = loadSessionEntry(scope);
  expect(first).toMatchObject({
    worktree: { canonicalWorkspaceDir: requestedWorkspace },
    updatedAt: 10,
  });
  const listWorktrees = vi.spyOn(worktreeRegistry, "listRegistryWorktreesForMigration");
  await runMigration();
  expect(listWorktrees).not.toHaveBeenCalled();
  expect(loadSessionEntry(scope)).toEqual(first);
  expect(loadSessionEntry(ordinaryScope)).toEqual(ordinaryBefore);
});

it("repairs a foreign logical row in its source partition without changing a same-key sibling", async () => {
  const { root, stateDir, env } = createFixture("openclaw-worktree-source-partition-");
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
  await replaceSessionEntry(sourceScope, worktreeEntry("source-session", workspace));
  await replaceSessionEntry(
    scope,
    worktreeEntry("sibling-session", path.join(root, "unrelated-workspace"), "legacy", 20),
  );
  const siblingBefore = loadSessionEntry(scope);
  const sourceBefore = loadSessionEntry(sourceScope);
  const runMigration = migration(cfg, env, storePath);

  await expect(runMigration()).resolves.toEqual({ found: 1, repaired: 1 });
  expect(loadSessionEntry(sourceScope)).toEqual(withWorkspace(sourceBefore, workspace));
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
  await expect(runMigration()).resolves.toEqual({ found: 0, repaired: 0 });
  expect(loadSessionEntry(scope)).toEqual(siblingBefore);
});

it("backfills each logical owner's workspace in a shared SQLite store", async () => {
  const { root, stateDir, env } = createFixture("openclaw-shared-worktree-workspace-migration-");
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
      worktreeEntry(`${agent.id}-session`, agent.workspace, agent.id),
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
  const before = readEntries();
  expect(before.map((entry) => entry?.sessionId)).toEqual(
    agents.map((agent) => `${agent.id}-session`),
  );
  const runMigration = migration(cfg, env, storePath, "ops");
  await expect(runMigration()).resolves.toEqual({ found: 2, repaired: 2 });
  const migrated = readEntries();
  expect(migrated).toEqual(
    before.map((entry, index) => withWorkspace(entry, agents[index]!.workspace)),
  );
  await expect(runMigration()).resolves.toEqual({ found: 0, repaired: 0 });
  expect(readEntries()).toEqual(migrated);
});

async function createRegisteredProjectMigrationFixture() {
  const fixture = await createManagedFixture("legacy-project");
  const { root, env, repoRoot, worktreeRoot, scope } = fixture;
  const otherRepoRoot = path.join(root, "other-project");
  const otherSpawnedCwd = path.join(worktreeRoot, "packages", "other");
  await mkdir(otherRepoRoot, otherSpawnedCwd);
  // Persisted legacy setup: public project registration separately validates Git.
  ensureProjectRegistrySchema({ env });
  const [project, otherProject] = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const register = (projectRoot: string) =>
        insertProjectRegistryInDatabase(db, {
          displayName: projectRoot,
          repoRoot: projectRoot,
          source: "registered",
        });
      return [register(repoRoot), register(otherRepoRoot)] as const;
    },
    { env },
  );
  const entry = { ...fixture.entry, projectId: project.id };
  replaceSessionEntrySync(scope, entry);
  return {
    ...fixture,
    entry,
    project,
    otherProject,
    otherRepoRoot,
    otherSpawnedCwd,
  };
}

it("backfills the persisted project workspace through the resolver once", async () => {
  const fixture = await createRegisteredProjectMigrationFixture();
  const before = loadSessionEntry(fixture.scope);
  await expect(fixture.runMigration()).resolves.toEqual({ found: 1, repaired: 1 });
  const migrated = loadSessionEntry(fixture.scope);
  expect(migrated).toEqual(withWorkspace(before, fixture.project.repoRoot));
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
