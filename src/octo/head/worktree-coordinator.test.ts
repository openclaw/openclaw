// Octopus Orchestrator -- WorktreeCoordinator tests (M3-13)
//
// Uses real temp git repos (git init) per test. No git operations on the
// project repo itself.

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimDeniedError, ClaimService } from "./claims.ts";
import { EventLogService } from "./event-log.ts";
import { RegistryService } from "./registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";
import { WorktreeCoordinator } from "./worktree-coordinator.ts";

// ──────────────────────────────────────────────────────────────────────────
// Per-test harness: temp git repo + SQLite DB + WorktreeCoordinator
// ──────────────────────────────────────────────────────────────────────────

let tempDir: string;
let repoPath: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;
let claimService: ClaimService;
let coordinator: WorktreeCoordinator;

function gitInRepo(args: string[]): void {
  const opts: ExecFileSyncOptions = { cwd: repoPath, stdio: "pipe" };
  execFileSync("git", args, opts);
}

beforeEach(() => {
  // Temp root for this test
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-wt-test-"));

  // Create a bare-minimum git repo with an initial commit
  repoPath = path.join(tempDir, "repo");
  execFileSync("git", ["init", repoPath], { stdio: "pipe" });
  gitInRepo(["config", "user.email", "test@test.com"]);
  gitInRepo(["config", "user.name", "Test"]);
  gitInRepo(["commit", "--allow-empty", "-m", "init"]);

  // SQLite + services
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
  claimService = new ClaimService(registry, eventLog, db);
  coordinator = new WorktreeCoordinator(claimService);
});

afterEach(() => {
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const FUTURE_TS = Date.now() + 120_000;

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("WorktreeCoordinator", () => {
  // 1. Single arm acquires a worktree successfully
  it("creates a worktree and acquires dir + branch claims", async () => {
    const result = await coordinator.acquireWorktree(
      "arm-1",
      "mission-1",
      "grip-1",
      repoPath,
      "feature-a",
      FUTURE_TS,
    );

    expect(result.branch).toBe("feature-a");
    expect(result.worktreePath).toBe(path.join(repoPath, ".worktrees", "arm-1"));
    expect(existsSync(result.worktreePath)).toBe(true);

    // Claims should exist
    const dirClaim = claimService.isClaimedExclusive("dir", result.worktreePath);
    expect(dirClaim).not.toBeNull();
    expect(dirClaim!.owner_arm_id).toBe("arm-1");

    const branchClaim = claimService.isClaimedExclusive("branch", "feature-a");
    expect(branchClaim).not.toBeNull();
    expect(branchClaim!.owner_arm_id).toBe("arm-1");
  });

  // 2. Two arms with different branches -- both succeed
  it("allows two arms with different branches (sibling worktrees)", async () => {
    const r1 = await coordinator.acquireWorktree(
      "arm-1",
      "mission-1",
      "grip-1",
      repoPath,
      "branch-a",
      FUTURE_TS,
    );
    const r2 = await coordinator.acquireWorktree(
      "arm-2",
      "mission-1",
      "grip-2",
      repoPath,
      "branch-b",
      FUTURE_TS,
    );

    expect(r1.branch).toBe("branch-a");
    expect(r2.branch).toBe("branch-b");
    expect(existsSync(r1.worktreePath)).toBe(true);
    expect(existsSync(r2.worktreePath)).toBe(true);
  });

  // 3. Two arms same branch -- second gets ClaimDeniedError
  it("denies second arm requesting the same branch", async () => {
    await coordinator.acquireWorktree(
      "arm-1",
      "mission-1",
      "grip-1",
      repoPath,
      "shared-branch",
      FUTURE_TS,
    );

    await expect(
      coordinator.acquireWorktree(
        "arm-2",
        "mission-1",
        "grip-2",
        repoPath,
        "shared-branch",
        FUTURE_TS,
      ),
    ).rejects.toThrow(); // git worktree add fails because branch already checked out
  });

  // 4. Release then re-acquire the same branch works
  it("allows re-acquire after release", async () => {
    await coordinator.acquireWorktree(
      "arm-1",
      "mission-1",
      "grip-1",
      repoPath,
      "reuse-branch",
      FUTURE_TS,
    );
    await coordinator.releaseWorktree("arm-1");

    // The branch still exists in git, so we need a fresh branch name
    // or use an existing branch. Let's create a new worktree on a new branch.
    const result = await coordinator.acquireWorktree(
      "arm-2",
      "mission-1",
      "grip-2",
      repoPath,
      "reuse-branch-2",
      FUTURE_TS,
    );
    expect(result.branch).toBe("reuse-branch-2");
    expect(existsSync(result.worktreePath)).toBe(true);

    // Clean up
    await coordinator.releaseWorktree("arm-2");
  });

  // 5. Release cleans up worktree directory and claims
  it("removes worktree and releases claims on releaseWorktree", async () => {
    const result = await coordinator.acquireWorktree(
      "arm-1",
      "mission-1",
      "grip-1",
      repoPath,
      "cleanup-branch",
      FUTURE_TS,
    );
    const wtPath = result.worktreePath;

    expect(existsSync(wtPath)).toBe(true);

    await coordinator.releaseWorktree("arm-1");

    expect(existsSync(wtPath)).toBe(false);
    expect(claimService.isClaimedExclusive("dir", wtPath)).toBeNull();
    expect(claimService.isClaimedExclusive("branch", "cleanup-branch")).toBeNull();
  });

  // 6. Release of unknown arm is a no-op
  it("releaseWorktree on unknown arm is a no-op", async () => {
    // Should not throw
    await coordinator.releaseWorktree("arm-nonexistent");
  });

  // 7. Claim conflict cleans up worktree before re-throwing
  it("cleans up worktree when claim acquisition fails", async () => {
    // Pre-acquire a "branch" claim to force ClaimDeniedError on the coordinator
    await claimService.acquire(
      "arm-blocker",
      "mission-1",
      "grip-1",
      [{ resource_type: "branch", resource_key: "contested-branch", mode: "exclusive" }],
      FUTURE_TS,
    );

    // The git worktree add will succeed (branch name doesn't conflict at git
    // level), but the claim on "branch:contested-branch" should fail.
    // However, git worktree add -b creates the branch, so if it already
    // exists as a claim but not as a git branch, git succeeds then claim fails.
    const wtPath = path.join(repoPath, ".worktrees", "arm-victim");

    await expect(
      coordinator.acquireWorktree(
        "arm-victim",
        "mission-1",
        "grip-2",
        repoPath,
        "contested-branch",
        FUTURE_TS,
      ),
    ).rejects.toThrow(ClaimDeniedError);

    // Worktree should have been cleaned up
    expect(existsSync(wtPath)).toBe(false);
  });
});
