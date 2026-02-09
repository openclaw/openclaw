/**
 * Workspace sync system
 * Auto-commits memory files to a configured private git repository
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export type WorkspaceSyncConfig = {
  repo?: string; // e.g., "git@github.com:user/private-openclaw-memory.git"
  enabled?: boolean;
  interval?: number; // milliseconds
  autoCommit?: boolean;
  autoPull?: boolean;
};

/**
 * Check if git is available
 */
export function isGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize git repository if not already initialized
 */
export function initializeGitRepo(repoPath: string, remoteUrl: string): boolean {
  try {
    // Check if git repo already exists
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      execSync("git init", { cwd: repoPath, stdio: "ignore" });
      execSync(`git remote add origin ${remoteUrl}`, { cwd: repoPath, stdio: "ignore" });
    }

    return true;
  } catch (err) {
    console.error(
      `[workspace-sync] Failed to initialize git repo at ${repoPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Pull latest changes from remote
 */
export function pullFromRemote(repoPath: string): boolean {
  try {
    execSync("git pull origin main --quiet", { cwd: repoPath, stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn(
      `[workspace-sync] Failed to pull from remote:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Get list of uncommitted changes
 */
export function getUncommittedChanges(repoPath: string): string[] {
  try {
    const output = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf8" });
    return output
      .trim()
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}

/**
 * Add and commit memory files to git
 */
export function commitMemoryFiles(repoPath: string, memoryPath: string): boolean {
  try {
    // Add memory files
    const relativeMemoryPath = path.relative(repoPath, memoryPath);
    execSync(`git add "${relativeMemoryPath}"`, { cwd: repoPath, stdio: "ignore" });

    // Check if there are changes to commit
    const changes = getUncommittedChanges(repoPath);
    if (changes.length === 0) {
      return false; // No changes to commit
    }

    const timestamp = new Date().toISOString();
    const message = `Auto-commit memory files: ${timestamp}`;

    execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn(
      `[workspace-sync] Failed to commit memory files:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Push changes to remote
 */
export function pushToRemote(repoPath: string): boolean {
  try {
    execSync("git push origin main --quiet", { cwd: repoPath, stdio: "ignore" });
    return true;
  } catch (err) {
    console.warn(
      `[workspace-sync] Failed to push to remote:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Perform full sync: pull, commit, push
 */
export function syncMemories(
  repoPath: string,
  memoryPath: string,
): {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
} {
  const result = {
    pulled: pullFromRemote(repoPath),
    committed: false,
    pushed: false,
  };

  // Only try to commit if we have memory files
  if (fs.existsSync(memoryPath)) {
    result.committed = commitMemoryFiles(repoPath, memoryPath);
  }

  // Push if we committed something
  if (result.committed) {
    result.pushed = pushToRemote(repoPath);
  }

  return result;
}

/**
 * Check if memory files have been modified since last sync
 */
export function hasMemoriesChanged(memoryPath: string, lastSyncTime?: number): boolean {
  try {
    if (!fs.existsSync(memoryPath)) {
      return false;
    }

    const stat = fs.statSync(memoryPath);
    if (!lastSyncTime) {
      return true; // First sync
    }

    // Check if any files were modified after last sync
    const walkDir = (dir: string): boolean => {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const filepath = path.join(dir, file);
        const stat = fs.statSync(filepath);

        if (stat.isDirectory()) {
          if (walkDir(filepath)) {
            return true;
          }
        } else if (stat.mtimeMs > lastSyncTime) {
          return true;
        }
      }

      return false;
    };

    return walkDir(memoryPath);
  } catch (err) {
    console.warn(
      `[workspace-sync] Error checking memory changes:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
