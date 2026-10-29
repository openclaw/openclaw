// Registered in the command suite to reuse its runtime and database fixture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { hasLiveWorktreeRunLease } from "../agents/worktrees/run-lease.test-support.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../skills/runtime/session-snapshot.js";
import type { writeSessionStoreSeed } from "./agent-session.test-support.js";

export function registerAgentManagedWorktreeTests({
  withTempHome,
  mockConfig,
  runIngress,
  seedSession,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (home: string, store: string) => OpenClawConfig;
  runIngress: (opts: {
    message: string;
    sessionKey: string;
    workspaceDir: string;
  }) => Promise<unknown>;
  seedSession: (
    store: string,
    key: string,
    entry: Parameters<typeof writeSessionStoreSeed>[1][string],
  ) => Promise<void>;
}) {
  it("uses the recorded canonical workspace for a managed-worktree skill snapshot", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:dashboard:managed-worktree";
      const canonicalWorkspace = path.join(home, "project");
      const git = (...args: string[]) => execFileSync("git", ["-C", canonicalWorkspace, ...args]);
      fs.mkdirSync(canonicalWorkspace, { recursive: true });
      git("init", "-b", "main");
      git("config", "user.name", "OpenClaw Test");
      git("config", "user.email", "openclaw-test@example.invalid");
      fs.writeFileSync(path.join(canonicalWorkspace, "README.md"), "base\n");
      git("add", "README.md");
      git("commit", "-m", "initial");
      mockConfig(home, store);
      const worktree = await managedWorktrees.create({
        repoRoot: canonicalWorkspace,
        baseRef: "HEAD",
        name: "managed",
        ownerKind: "session",
        ownerId: sessionKey,
      });
      await seedSession(store, sessionKey, {
        sessionId: "managed-worktree-session",
        spawnedCwd: worktree.path,
        worktree: {
          id: worktree.id,
          branch: worktree.branch,
          repoRoot: worktree.repoRoot,
          canonicalWorkspaceDir: canonicalWorkspace,
        },
      });

      await runIngress({ message: "inspect this repo", sessionKey, workspaceDir: worktree.path });
      expect(hasLiveWorktreeRunLease(process.env, worktree.id)).toBe(false);

      const skillRoots = vi.mocked(resolveReusableWorkspaceSkillSnapshot).mock.calls.at(-1)?.[0];
      expect(skillRoots?.workspaceDir).toBe(path.join(home, "openclaw"));
      expect(skillRoots?.executionWorkspaceDir).toBe(canonicalWorkspace);
    });
  });
}
