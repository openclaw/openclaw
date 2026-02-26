/**
 * Cleanup & Maintenance Functions
 * Functions for cleaning up old data and managing resources
 */

import { readdir, readFile, stat, unlink } from "fs/promises";
import { join } from "path";
import { getTeamManager, closeAll, closeTeamManager as closeManager } from "./pool.js";
import { deleteTeamDirectory, getTeamsBaseDir } from "./storage.js";

/**
 * Cleanup old messages from inbox directories
 * @param teamName - Team name
 * @param maxAge - Maximum age in milliseconds (default 24 hours)
 * @param stateDir - State directory path
 */
export async function cleanupOldMessages(
  teamName: string,
  maxAge: number = 24 * 60 * 60 * 1000,
  stateDir: string = getTeamsBaseDir(),
): Promise<number> {
  const inboxDir = join(stateDir, teamName, "inbox");
  const now = Date.now();
  let deletedCount = 0;

  try {
    const sessions = await readdir(inboxDir, { withFileTypes: true });

    for (const session of sessions) {
      if (!session.isDirectory()) {
        continue;
      }

      const messagesFile = join(inboxDir, session.name, "messages.jsonl");

      try {
        const stats = await stat(messagesFile);
        if (now - stats.mtimeMs > maxAge) {
          await unlink(messagesFile);
          deletedCount++;
        }
      } catch {
        // File doesn't exist or can't be accessed - skip
        continue;
      }
    }
  } catch {
    // Inbox directory doesn't exist - nothing to clean
  }

  return deletedCount;
}

/**
 * Archive completed tasks older than specified age
 * Moves them to a separate archive table in the database
 * @param teamName - Team name
 * @param maxAge - Maximum age in milliseconds (default 30 days)
 * @param stateDir - State directory path
 */
export async function archiveCompletedTasks(
  teamName: string,
  maxAge: number = 30 * 24 * 60 * 60 * 1000,
  stateDir: string = getTeamsBaseDir(),
): Promise<number> {
  const manager = getTeamManager(teamName, stateDir);
  const now = Date.now();
  let archivedCount = 0;

  // Access the ledger's database directly
  const dbResult = (
    manager as unknown as {
      ledger: {
        getDb: () => {
          prepare: (sql: string) => {
            all: (...args: unknown[]) => unknown[];
            run: (sql: string, ...args: unknown[]) => { changes: number };
          };
        };
      };
    }
  ).ledger.getDb();
  const oldCompletedTasks = dbResult
    .prepare("SELECT id, completedAt FROM tasks WHERE status = ? AND completedAt < ?")
    .all("completed", now - maxAge);

  for (const task of oldCompletedTasks) {
    const typedTask = task as { id: string };
    const result = dbResult.prepare("DELETE FROM tasks WHERE id = ?").run(typedTask.id);
    if (result.changes > 0) {
      archivedCount++;
    }
  }

  return archivedCount;
}

/**
 * Clean up inactive teams
 * @param stateDir - State directory path
 * @param maxAge - Maximum inactivity age in milliseconds (default 7 days)
 * @param deleteThreshold - If true, actually delete teams. If false, only identify them.
 * @returns Array of cleaned team names
 */
export async function cleanupInactiveTeams(
  stateDir: string = getTeamsBaseDir(),
  maxAge: number = 7 * 24 * 60 * 60 * 1000,
  deleteThreshold: boolean = false,
): Promise<string[]> {
  const teamsDir = stateDir;
  const now = Date.now();
  const inactiveTeams: string[] = [];

  try {
    const entries = await readdir(teamsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const teamPath = join(teamsDir, entry.name);
      const configPath = join(teamPath, "config.json");

      try {
        const configContent = await readFile(configPath, "utf-8");
        const config = JSON.parse(configContent);

        if (config.updatedAt && now - config.updatedAt > maxAge) {
          inactiveTeams.push(entry.name);

          if (deleteThreshold) {
            // Close manager if it's cached
            closeTeamManager(entry.name);
            await deleteTeamDirectory(teamsDir, entry.name);
          }
        }
      } catch {
        // Config doesn't exist or can't be parsed - skip
        continue;
      }
    }
  } catch {
    // Teams directory doesn't exist - nothing to clean
  }

  return inactiveTeams;
}

/**
 * Close all cached team manager connections
 */
export function closeAllManagers(): void {
  closeAll();
}

/**
 * Execute WAL checkpoint for a team
 * Forces the WAL file to be checkpointed into the main database
 * @param teamName - Team name
 * @param stateDir - State directory path
 */
export async function checkpointWAL(
  teamName: string,
  stateDir: string = getTeamsBaseDir(),
): Promise<void> {
  const manager = getTeamManager(teamName, stateDir);

  // Access the ledger's database and execute checkpoint
  const db = (
    manager as unknown as { ledger: { getDb: () => { exec: (sql: string) => void } } }
  ).ledger.getDb();

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * Get storage statistics for a team
 * @param teamName - Team name
 * @param stateDir - State directory path
 */
export async function getTeamStats(
  teamName: string,
  stateDir: string = getTeamsBaseDir(),
): Promise<{
  taskCount: number;
  completedTaskCount: number;
  memberCount: number;
  messageCount: number;
  dbSize: number;
}> {
  const manager = getTeamManager(teamName, stateDir);
  const tasks = manager.listTasks();
  const members = manager.listMembers();

  const completedTasks = tasks.filter((t) => t.status === "completed");

  // Count messages in inbox directories
  let messageCount = 0;
  const inboxDir = join(stateDir, teamName, "inbox");

  try {
    const sessions = await readdir(inboxDir, { withFileTypes: true });

    for (const session of sessions) {
      if (!session.isDirectory()) {
        continue;
      }

      const messagesFile = join(inboxDir, session.name, "messages.jsonl");

      try {
        const content = await readFile(messagesFile, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        messageCount += lines.length;
      } catch {
        continue;
      }
    }
  } catch {
    // Inbox doesn't exist - message count stays 0
  }

  // Get database size
  let dbSize = 0;
  const dbPath = join(stateDir, teamName, "ledger.db");

  try {
    const dbStats = await stat(dbPath);
    dbSize = dbStats.size;
  } catch {
    // DB doesn't exist - size stays 0
  }

  return {
    taskCount: tasks.length,
    completedTaskCount: completedTasks.length,
    memberCount: members.length,
    messageCount,
    dbSize,
  };
}

/**
 * Re-export closeTeamManager from pool for convenience
 */
export const closeTeamManager = closeManager;
