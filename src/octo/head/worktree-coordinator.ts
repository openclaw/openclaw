// Octopus Orchestrator -- WorktreeCoordinator (M3-13)
//
// Manages git worktree lifecycle for parallel coding arms. Each arm gets
// an isolated worktree + branch pair, coordinated via ClaimService to
// prevent two arms from using the same directory or branch.
//
// Context docs:
//   - LLD ClaimRecord -- resource_type: "dir", "branch"
//   - M3-05 ClaimService -- acquire/release/ClaimDeniedError
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline (only src/octo/ imports)

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ClaimRequest } from "../wire/schema.ts";
import { ClaimDeniedError, type ClaimService } from "./claims.ts";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────
// Internal bookkeeping for active worktrees
// ──────────────────────────────────────────────────────────────────────────

interface WorktreeEntry {
  armId: string;
  worktreePath: string;
  branch: string;
  repoPath: string;
  claimIds: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// WorktreeCoordinator
// ──────────────────────────────────────────────────────────────────────────

export class WorktreeCoordinator {
  private readonly gitBin: string;
  private readonly entries = new Map<string, WorktreeEntry>();

  constructor(
    private readonly claimService: ClaimService,
    opts?: { gitBin?: string },
  ) {
    this.gitBin = opts?.gitBin ?? "git";
  }

  /**
   * Create a git worktree for an arm and acquire exclusive claims on the
   * worktree directory and the branch name.
   *
   * If claim acquisition fails (ClaimDeniedError), the worktree is removed
   * before re-throwing.
   */
  async acquireWorktree(
    armId: string,
    missionId: string,
    gripId: string,
    repoPath: string,
    branchName: string,
    leaseExpiryTs: number,
  ): Promise<{ worktreePath: string; branch: string }> {
    const worktreePath = path.join(repoPath, ".worktrees", armId);

    // 1. Create the git worktree with a new branch
    await execFileAsync(this.gitBin, ["worktree", "add", "-b", branchName, worktreePath], {
      cwd: repoPath,
    });

    // 2. Acquire exclusive claims on both dir and branch
    const claims: ClaimRequest[] = [
      { resource_type: "dir", resource_key: worktreePath, mode: "exclusive" },
      { resource_type: "branch", resource_key: branchName, mode: "exclusive" },
    ];

    try {
      const records = await this.claimService.acquire(
        armId,
        missionId,
        gripId,
        claims,
        leaseExpiryTs,
      );

      const claimIds = records.map((r) => r.claim_id);

      this.entries.set(armId, {
        armId,
        worktreePath,
        branch: branchName,
        repoPath,
        claimIds,
      });

      return { worktreePath, branch: branchName };
    } catch (err: unknown) {
      // Clean up the worktree if claim acquisition fails
      await execFileAsync(this.gitBin, ["worktree", "remove", "--force", worktreePath], {
        cwd: repoPath,
      });
      throw err;
    }
  }

  /**
   * Remove the worktree and release all associated claims.
   */
  async releaseWorktree(armId: string): Promise<void> {
    const entry = this.entries.get(armId);
    if (!entry) {
      return;
    }

    // 1. Remove the git worktree
    await execFileAsync(this.gitBin, ["worktree", "remove", "--force", entry.worktreePath], {
      cwd: entry.repoPath,
    });

    // 2. Release claims
    await this.claimService.release(armId, entry.claimIds);

    // 3. Clean up internal state
    this.entries.delete(armId);
  }
}

export { ClaimDeniedError };
