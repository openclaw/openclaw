import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  type CheckpointData,
  checkpointPath,
  createCheckpoint,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint.js";
import { matchCapabilities } from "./capability-matcher.js";
import { parseTaskFrontmatter } from "./frontmatter.js";
import { QueueManager } from "./queue-manager.js";
import type { TaskFrontmatter } from "./types.js";

const log = createSubsystemLogger("projects/heartbeat-scanner");

// -- Scanner types --

export type ScanAndClaimResult =
  | { type: "idle" }
  | {
      type: "claimed";
      task: { id: string; path: string; content: string };
      checkpoint: CheckpointData;
    }
  | {
      type: "resumed";
      task: { id: string; path: string; content: string };
      checkpoint: CheckpointData;
    };

export interface ScanAndClaimOpts {
  agentId: string;
  agentCapabilities: string[];
  projectDir: string;
}

/** Priority ordering: lower number = higher priority. */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// -- Core scanner --

/**
 * Scan for an active task to resume or a new task to claim from the queue.
 *
 * Algorithm:
 * 1. Check for active checkpoint (short-circuit resume)
 * 2. Read queue.md Available entries
 * 3. Filter by capabilities and dependency satisfaction
 * 4. Sort by priority (critical > high > medium > low), then queue position
 * 5. Claim highest priority match
 * 6. Return idle if nothing claimable
 *
 * Never throws -- always returns a result.
 */
export async function scanAndClaimTask(opts: ScanAndClaimOpts): Promise<ScanAndClaimResult> {
  const { agentId, agentCapabilities, projectDir } = opts;

  // Step 1: Check for active checkpoint (resume short-circuit)
  const resumed = await findActiveCheckpoint(projectDir, agentId);
  if (resumed) return resumed;

  // Step 2-5: Scan queue and claim
  try {
    const qm = new QueueManager(projectDir);
    const queue = await qm.readQueue();

    if (queue.available.length === 0) {
      return { type: "idle" };
    }

    // Step 3: Filter claimable tasks
    const claimable = await filterClaimableTasks(
      queue.available.map((e) => e.taskId),
      projectDir,
      agentCapabilities,
    );

    if (claimable.length === 0) {
      return { type: "idle" };
    }

    // Step 4: Sort by priority, preserve queue position for ties
    // claimable is already in queue order from filterClaimableTasks,
    // so a stable sort by priority preserves positional tiebreak.
    const sorted = sortByPriority(claimable);

    // Step 5: Claim the top task
    const best = sorted[0];
    const taskFilePath = path.join(projectDir, "tasks", `${best.id}.md`);
    const content = await fs.readFile(taskFilePath, "utf8");

    await qm.claimTask(best.id, agentId);

    const checkpoint = createCheckpoint({ agentId, taskId: best.id });
    const cpPath = checkpointPath(taskFilePath);
    await writeCheckpoint(cpPath, checkpoint);

    return {
      type: "claimed",
      task: { id: best.id, path: taskFilePath, content },
      checkpoint,
    };
  } catch (err) {
    log.warn("Queue scan failed, returning idle", {
      error: err instanceof Error ? err.message : String(err),
      projectDir,
    });
    return { type: "idle" };
  }
}

// -- Helpers --

/** Scan tasks/ directory for an active checkpoint belonging to this agent. */
async function findActiveCheckpoint(
  projectDir: string,
  agentId: string,
): Promise<ScanAndClaimResult | null> {
  const tasksDir = path.join(projectDir, "tasks");

  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return null;
  }

  const cpFiles = entries.filter((f) => f.endsWith(".checkpoint.json"));
  for (const cpFile of cpFiles) {
    const cpFilePath = path.join(tasksDir, cpFile);
    const checkpoint = await readCheckpoint(cpFilePath);

    // Skip corrupted or non-matching checkpoints
    if (!checkpoint) continue;
    if (checkpoint.claimed_by !== agentId) continue;
    if (checkpoint.status !== "in-progress") continue;

    // Found an active task -- read the matching .md file
    const taskId = cpFile.replace(".checkpoint.json", "");
    const taskFilePath = path.join(tasksDir, `${taskId}.md`);

    try {
      const content = await fs.readFile(taskFilePath, "utf8");
      return {
        type: "resumed",
        task: { id: taskId, path: taskFilePath, content },
        checkpoint,
      };
    } catch {
      log.warn("Active checkpoint found but task file missing", { taskId, agentId });
      continue;
    }
  }

  return null;
}

/**
 * Filter available task IDs to those claimable by this agent.
 * Preserves input order (queue position) for downstream stable sort.
 */
async function filterClaimableTasks(
  taskIds: string[],
  projectDir: string,
  agentCapabilities: string[],
): Promise<Array<{ id: string; priority: string }>> {
  const claimable: Array<{ id: string; priority: string }> = [];
  const tasksDir = path.join(projectDir, "tasks");

  for (const taskId of taskIds) {
    const taskFilePath = path.join(tasksDir, `${taskId}.md`);

    let content: string;
    try {
      content = await fs.readFile(taskFilePath, "utf8");
    } catch {
      log.warn("Task file not found, skipping", { taskId });
      continue;
    }

    const result = parseTaskFrontmatter(content, taskFilePath);
    if (!result.success) {
      log.warn("Task frontmatter parse failed, skipping", { taskId });
      continue;
    }

    const fm: TaskFrontmatter = result.data;

    // Capability check
    if (!matchCapabilities(agentCapabilities, fm.capabilities)) {
      continue;
    }

    // Dependency check: ALL depends_on must be "done"
    if (fm.depends_on.length > 0) {
      const allDone = await checkAllDepsDone(fm.depends_on, tasksDir);
      if (!allDone) continue;
    }

    claimable.push({ id: taskId, priority: fm.priority });
  }

  return claimable;
}

/** Check that every dependency task has status "done". */
async function checkAllDepsDone(depIds: string[], tasksDir: string): Promise<boolean> {
  for (const depId of depIds) {
    const depPath = path.join(tasksDir, `${depId}.md`);
    try {
      const content = await fs.readFile(depPath, "utf8");
      const result = parseTaskFrontmatter(content, depPath);
      if (!result.success || result.data.status !== "done") {
        return false;
      }
    } catch {
      // Missing dep file = not done (safe default)
      return false;
    }
  }
  return true;
}

/** Stable sort by priority (critical > high > medium > low). */
function sortByPriority(
  tasks: Array<{ id: string; priority: string }>,
): Array<{ id: string; priority: string }> {
  // Slice to avoid mutating input, then stable sort
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    return pa - pb;
  });
}
