import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { deleteRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

let root: string;
let stateRoot: string;
let repo: string;
let canonical: string;
let owner: LocalWorkspaceOwner;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const readText = (directory: string, ...parts: string[]) =>
  fs.readFile(path.join(directory, ...parts), "utf8");
const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
const synchronize = () =>
  withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
const settleProjection = () => withLocalWorkspaceProjection(owner, (state) => state.settle());
const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
async function expectText(directory: string, relative: string, expected: string) {
  expect(await readText(directory, relative)).toBe(expected);
}

const suiteDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
beforeAll(() => {
  stateRoot = suiteDirs.make("openclaw-local-projection-conflict-state-");
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot } });
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-projection-conflict-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitNullConfigPath());
  vi.stubEnv("GIT_CONFIG_SYSTEM", gitNullConfigPath());
  setRuntimeConfigSnapshot({});
  repo = path.join(root, "source");
  canonical = path.join(root, "canonical");
  await fs.mkdir(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await writeText(repo, "source.txt", "original\n");
  await writeText(repo, ".gitignore", ".env.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", canonical);
  await writeText(canonical, ".env.local", "host-only-secret");
  const sessionKey = `agent:main:dashboard:guest-${randomUUID()}`;
  owner = {
    agentId: "main",
    sessionKey,
    sessionId: randomUUID(),
    lifecycleRevision: null,
    assertCurrent: () => {},
    worktree: {
      id: randomUUID(),
      name: "guest",
      repoFingerprint: "test",
      repoRoot: repo,
      path: canonical,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 0,
      lastActiveAt: 0,
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    const row = store.get();
    if (row) {
      await store.delete(row);
      await fs.rm(path.dirname(row.projection_path), { recursive: true, force: true });
    }
  });
  await deleteRegistryWorktree(process.env, owner.worktree.id);
  if (process.env.OPENCLAW_STATE_DIR !== stateRoot) {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
  }
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("admits a reconciled third version combining human and guest edits after a conflict", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest contribution\n");
  await writeText(canonical, "source.txt", "human contribution\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();
  await expectText(canonical, "source.txt", "human contribution\n");
  await expectText(projection, "source.txt", "guest contribution\n");

  // Administrator writes a third merged version combining human and guest edits
  await writeText(canonical, "source.txt", "merged human and guest contribution\n");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "merged human and guest contribution\n");
  await expectText(projection, "source.txt", "merged human and guest contribution\n");
});

it("recovers a retained conflict across restart and admits a merged resolution", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest task work\n");
  await writeText(canonical, "source.txt", "coordinator instructions\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Simulate gateway restart
  await closeOpenClawStateDatabaseAsync();
  await expect(settleProjection()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Reconciled third version combining work
  await writeText(canonical, "source.txt", "coordinator instructions + guest task work\n");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "coordinator instructions + guest task work\n");
  await expectText(projection, "source.txt", "coordinator instructions + guest task work\n");
});
