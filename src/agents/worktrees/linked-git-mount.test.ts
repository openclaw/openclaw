import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveManagedWorktreeGitMount } from "./linked-git-mount.js";
import { getRegistryWorktree, insertRegistryWorktree } from "./registry.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed worktree Git mount", () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let env: NodeJS.ProcessEnv;
  const ownerId = "agent:main:subagent:task";

  beforeEach(async () => {
    root = tempDirs.make("openclaw-git-mount-");
    repo = path.join(root, "repo");
    worktree = path.join(root, "worktree");
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    await execFileAsync("git", ["init", "-b", "main", repo]);
    await fs.writeFile(path.join(repo, "README.md"), "fixture\n");
    await execFileAsync("git", ["-C", repo, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "task", worktree]);
    insertRegistryWorktree(env, {
      id: "managed",
      name: "task",
      repoFingerprint: "0123456789abcdef",
      repoRoot: repo,
      path: worktree,
      branch: "task",
      baseRef: "main",
      ownerKind: "session",
      ownerId,
      createdAt: 1,
      lastActiveAt: 1,
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps shared metadata read-only without adding sandbox provenance", async () => {
    await expect(
      resolveManagedWorktreeGitMount({ workspaceDir: worktree, env }),
    ).resolves.toMatchObject({
      hostPath: path.join(repo, ".git"),
      readOnly: true,
    });
    expect(getRegistryWorktree(env, "managed")?.sandboxGit).toBeUndefined();
  });

  it("persists same-session provenance before returning a writable mount", async () => {
    await expect(
      resolveManagedWorktreeGitMount({
        workspaceDir: worktree,
        env,
        writableBySessionKey: ownerId,
      }),
    ).resolves.toMatchObject({ hostPath: path.join(repo, ".git"), readOnly: false });
    expect(getRegistryWorktree(env, "managed")?.sandboxGit).toBe(true);
  });

  it("refuses writable metadata to a different session", async () => {
    await expect(
      resolveManagedWorktreeGitMount({
        workspaceDir: worktree,
        env,
        writableBySessionKey: "agent:other:main",
      }),
    ).rejects.toThrow("owned by this session");
    expect(getRegistryWorktree(env, "managed")?.sandboxGit).toBeUndefined();
  });

  it("allows descendants to reuse metadata that is already persistently tainted", async () => {
    await resolveManagedWorktreeGitMount({
      workspaceDir: worktree,
      env,
      writableBySessionKey: ownerId,
    });
    await expect(
      resolveManagedWorktreeGitMount({
        workspaceDir: worktree,
        env,
        writableBySessionKey: "agent:main:subagent:descendant",
      }),
    ).resolves.toMatchObject({ readOnly: false });
  });
});
