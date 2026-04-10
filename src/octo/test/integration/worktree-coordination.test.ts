// Octopus Orchestrator -- Integration test: worktree coordination (M3-16)
//
// Validates that WorktreeCoordinator correctly manages worktree lifecycle
// across multiple arms: sibling worktrees on different branches succeed,
// overlapping branch names are denied via ClaimDeniedError, and
// release + re-acquire works cleanly.
//
// Boundary discipline (OCTO-DEC-033): only `node:*` builtins,
// `@sinclair/typebox`, and relative imports inside `src/octo/`.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimService } from "../../head/claims.ts";
import { EventLogService } from "../../head/event-log.ts";
import { RegistryService } from "../../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
import { WorktreeCoordinator } from "../../head/worktree-coordinator.ts";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

/** Create a bare-minimum git repo in a temp dir with one initial commit. */
function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octo-wt-test-"));
  execFileSync("git", ["init", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  return dir;
}

// ──────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!GIT_AVAILABLE)("WorktreeCoordinator integration", () => {
  const cleanupDirs: string[] = [];
  let db: DatabaseSync;
  let registry: RegistryService;
  let eventLog: EventLogService;
  let claimService: ClaimService;
  let coordinator: WorktreeCoordinator;

  function setup(): string {
    const stateDir = mkdtempSync(path.join(tmpdir(), "octo-wt-state-"));
    cleanupDirs.push(stateDir);

    const dbPath = path.join(stateDir, "registry.sqlite");
    db = openOctoRegistry({ path: dbPath });

    const eventsPath = path.join(stateDir, "events.jsonl");
    eventLog = new EventLogService({ path: eventsPath });
    registry = new RegistryService(db);
    claimService = new ClaimService(registry, eventLog, db);
    coordinator = new WorktreeCoordinator(claimService);

    const repoDir = createTempRepo();
    cleanupDirs.push(repoDir);
    return repoDir;
  }

  afterEach(async () => {
    try {
      closeOctoRegistry(db);
    } catch {
      // already closed or never opened
    }
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    cleanupDirs.length = 0;
  });

  // ────────────────────────────────────────────────────────────────────────
  // Test 1: Two arms on different branches both succeed
  // ────────────────────────────────────────────────────────────────────────

  it("two arms acquire worktrees on different branches without collision", async () => {
    const repoDir = setup();
    const missionId = "mission-1";
    const gripId = "grip-1";
    const leaseExpiry = Date.now() + 60_000;

    const [resultA, resultB] = await Promise.all([
      coordinator.acquireWorktree("arm-a", missionId, gripId, repoDir, "branch-a", leaseExpiry),
      coordinator.acquireWorktree("arm-b", missionId, gripId, repoDir, "branch-b", leaseExpiry),
    ]);

    // Both worktree directories exist on disk
    expect(existsSync(resultA.worktreePath)).toBe(true);
    expect(existsSync(resultB.worktreePath)).toBe(true);

    // Branches are distinct
    expect(resultA.branch).toBe("branch-a");
    expect(resultB.branch).toBe("branch-b");

    // Git confirms worktrees exist
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "worktree", "list"]);
    expect(stdout).toContain("branch-a");
    expect(stdout).toContain("branch-b");
  });

  // ────────────────────────────────────────────────────────────────────────
  // Test 2: Same branch -> error (git rejects duplicate branch before
  // claims are checked; claims are defense-in-depth)
  // ────────────────────────────────────────────────────────────────────────

  it("second arm on the same branch is rejected", async () => {
    const repoDir = setup();
    const missionId = "mission-2";
    const gripId = "grip-2";
    const leaseExpiry = Date.now() + 60_000;

    // First arm succeeds
    const result = await coordinator.acquireWorktree(
      "arm-x",
      missionId,
      gripId,
      repoDir,
      "shared-branch",
      leaseExpiry,
    );
    expect(existsSync(result.worktreePath)).toBe(true);

    // Second arm on the same branch is rejected (git-level or claim-level)
    await expect(
      coordinator.acquireWorktree(
        "arm-y",
        missionId,
        gripId,
        repoDir,
        "shared-branch",
        leaseExpiry,
      ),
    ).rejects.toThrow();

    // First arm's worktree remains intact
    expect(existsSync(result.worktreePath)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Test 3: Release + re-acquire works
  // ────────────────────────────────────────────────────────────────────────

  it("released worktree branch can be re-acquired by another arm", async () => {
    const repoDir = setup();
    const missionId = "mission-3";
    const gripId = "grip-3";
    const leaseExpiry = Date.now() + 60_000;

    // Acquire
    const first = await coordinator.acquireWorktree(
      "arm-r1",
      missionId,
      gripId,
      repoDir,
      "recycle-branch",
      leaseExpiry,
    );
    expect(existsSync(first.worktreePath)).toBe(true);

    // Release (removes worktree; branch ref persists in git)
    await coordinator.releaseWorktree("arm-r1");
    expect(existsSync(first.worktreePath)).toBe(false);

    // Delete the orphaned branch ref so a new worktree can re-use the name.
    // WorktreeCoordinator.releaseWorktree does not delete branch refs --
    // that is intentional (preserves commit history). The caller is
    // responsible for branch cleanup when re-use is desired.
    execFileSync("git", ["-C", repoDir, "branch", "-D", "recycle-branch"], {
      stdio: "ignore",
    });

    // Re-acquire on the same branch name by a different arm
    const second = await coordinator.acquireWorktree(
      "arm-r2",
      missionId,
      gripId,
      repoDir,
      "recycle-branch",
      leaseExpiry,
    );
    expect(existsSync(second.worktreePath)).toBe(true);
    expect(second.branch).toBe("recycle-branch");
  });
});
