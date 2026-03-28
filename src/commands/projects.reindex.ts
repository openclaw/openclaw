import fs from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { generateAllIndexes } from "../projects/index-generator.js";
import { ProjectSyncService } from "../projects/sync-service.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsReindexOptions = {
  json?: boolean;
};

type ProjectsReindexContext = {
  homeDir?: string;
};

/** Check if a PID is alive by sending signal 0. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function projectsReindexCommand(
  opts: ProjectsReindexOptions = {},
  context: ProjectsReindexContext = {},
  runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  const home = context.homeDir ?? resolveRequiredHomeDir();
  const projectsRoot = path.join(home, ".openclaw", "projects");
  const syncService = new ProjectSyncService(projectsRoot);
  const projectDirs = await syncService.discoverProjects();

  if (projectDirs.length === 0) {
    runtime.log("No projects found. Create one with: openclaw projects create <name>");
    return;
  }

  // Reindex each project
  for (const projectDir of projectDirs) {
    const projectName = path.basename(projectDir);
    await generateAllIndexes(projectDir);

    // Count task files
    let taskCount = 0;
    try {
      const entries = await fs.readdir(path.join(projectDir, "tasks"));
      taskCount = entries.filter((e) => /^TASK-\d+\.md$/.test(e)).length;
    } catch {
      // tasks/ missing
    }

    runtime.log(`Reindexed: ${projectName} (${taskCount} tasks)`);
  }

  // Scan and clear stale lock files
  let locksCleared = 0;
  const now = Date.now();
  const staleLockThresholdMs = 60_000;

  for (const projectDir of projectDirs) {
    try {
      const entries = await findLockFiles(projectDir);
      for (const lockPath of entries) {
        try {
          const content = await fs.readFile(lockPath, "utf-8");
          const lockData = JSON.parse(content) as { pid?: number; timestamp?: number };

          const isStale = !lockData.timestamp || now - lockData.timestamp > staleLockThresholdMs;
          const isDead = !lockData.pid || !isPidAlive(lockData.pid);

          if (isStale || isDead) {
            await fs.unlink(lockPath);
            locksCleared++;
          }
        } catch {
          // Unreadable or malformed lock file — remove it
          try {
            await fs.unlink(lockPath);
            locksCleared++;
          } catch {
            // Already gone
          }
        }
      }
    } catch {
      // Skip project on error
    }
  }

  runtime.log(`Reindexed ${projectDirs.length} project(s). Cleared ${locksCleared} stale lock(s).`);

  if (opts.json) {
    runtime.writeJson({ projects: projectDirs.length, locksCleared });
  }
}

/** Recursively find all .lock files under a directory. */
async function findLockFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await findLockFiles(fullPath);
        results.push(...nested);
      } else if (entry.name.endsWith(".lock")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory unreadable
  }
  return results;
}
