import { rename, readFile, writeFile } from "node:fs/promises";

/**
 * Checkpoint data persisted alongside each task markdown file.
 * Enables agent resume after context compaction by recording
 * progress, failed approaches, and next actions.
 */
export interface CheckpointData {
  status: "in-progress" | "review" | "done" | "blocked";
  claimed_by: string;
  claimed_at: string;
  last_step: string;
  next_action: string;
  progress_pct: number;
  files_modified: string[];
  failed_approaches: Array<{ approach: string; reason: string }>;
  log: Array<{ timestamp: string; agent: string; action: string }>;
  notes: string;
}

/**
 * Derive the checkpoint sidecar path from a task markdown path.
 * Example: "tasks/TASK-005.md" -> "tasks/TASK-005.checkpoint.json"
 */
export function checkpointPath(taskFilePath: string): string {
  return taskFilePath.replace(/\.md$/, ".checkpoint.json");
}

/**
 * Create initial checkpoint data when a task is claimed.
 */
export function createCheckpoint(opts: {
  agentId: string;
  taskId: string;
  timestamp?: string;
}): CheckpointData {
  const claimedAt = opts.timestamp ?? new Date().toISOString();
  return {
    status: "in-progress",
    claimed_by: opts.agentId,
    claimed_at: claimedAt,
    last_step: "",
    next_action: "",
    progress_pct: 0,
    files_modified: [],
    failed_approaches: [],
    log: [{ timestamp: claimedAt, agent: opts.agentId, action: "Claimed task" }],
    notes: "",
  };
}

/**
 * Write checkpoint data atomically via temp file + rename.
 * Prevents partial reads if another process reads concurrently.
 */
export async function writeCheckpoint(filePath: string, data: CheckpointData): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, "\t"), "utf-8");
  await rename(tmpPath, filePath);
}

/**
 * Read and parse a checkpoint file. Returns null if the file
 * does not exist or contains corrupted JSON (graceful degradation).
 */
export async function readCheckpoint(filePath: string): Promise<CheckpointData | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as CheckpointData;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      // Corrupted JSON -- warn but don't throw
      console.warn(`[checkpoint] corrupted checkpoint file: ${filePath}`);
      return null;
    }
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Type guard for Node.js filesystem errors with a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
