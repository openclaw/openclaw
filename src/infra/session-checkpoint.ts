/**
 * Session checkpoint/recovery system
 * Saves and restores session state for long operations and gateway restarts
 */

import fs from "fs";
import os from "os";
import path from "path";

/**
 * Session checkpoint data structure for state persistence
 */
export interface SessionCheckpoint {
  /** Unique identifier for the session */
  sessionKey: string;
  /** Unix timestamp when checkpoint was created */
  timestamp: number;
  /** Name of the operation being checkpointed */
  operation: string;
  /** Arbitrary state data to persist - should be JSON serializable */
  state: Record<string, unknown>;
  /** Optional breadcrumb trail for debugging complex operations */
  breadcrumbs?: string[];
}

/**
 * Options for checkpoint cleanup operations
 */
export interface CheckpointCleanupOptions {
  /** Maximum age in milliseconds (default: 7 days) */
  maxAgeMs?: number;
  /** Dry run mode - don't actually delete files */
  dryRun?: boolean;
}

// Checkpoint directory: ~/.openclaw/checkpoints/
function getCheckpointDir(): string {
  return path.join(os.homedir(), ".openclaw", "checkpoints");
}

function ensureCheckpointDir(): void {
  const dir = getCheckpointDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getCheckpointPath(sessionKey: string): string {
  const dir = getCheckpointDir();
  const filename = `${sessionKey.replace(/[\/]/g, "_")}.json`;
  return path.join(dir, filename);
}

/**
 * Validates checkpoint data structure
 * @param data Raw checkpoint data from file
 * @returns True if valid checkpoint structure
 */
function isValidCheckpoint(data: unknown): data is SessionCheckpoint {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as any).sessionKey === "string" &&
    typeof (data as any).timestamp === "number" &&
    typeof (data as any).operation === "string" &&
    typeof (data as any).state === "object" &&
    (data as any).state !== null
  );
}

/**
 * Save a checkpoint for a session
 * @param checkpoint Checkpoint data to save
 */
export function saveCheckpoint(checkpoint: SessionCheckpoint): void {
  try {
    ensureCheckpointDir();
    const filepath = getCheckpointPath(checkpoint.sessionKey);
    fs.writeFileSync(filepath, JSON.stringify(checkpoint, null, 2), "utf8");
  } catch (err) {
    console.error(
      `[session-checkpoint] Failed to save checkpoint for ${checkpoint.sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Restore a checkpoint for a session
 */
export function restoreCheckpoint(sessionKey: string): SessionCheckpoint | null {
  try {
    const filepath = getCheckpointPath(sessionKey);
    if (!fs.existsSync(filepath)) {
      return null;
    }

    const data = fs.readFileSync(filepath, "utf8");
    const parsedData = JSON.parse(data);

    // Validate checkpoint structure
    if (!isValidCheckpoint(parsedData)) {
      console.warn(`[session-checkpoint] Invalid checkpoint structure for ${sessionKey}`);
      return null;
    }

    return parsedData;
  } catch (err) {
    console.error(
      `[session-checkpoint] Failed to restore checkpoint for ${sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Delete a checkpoint for a session
 */
export function deleteCheckpoint(sessionKey: string): void {
  try {
    const filepath = getCheckpointPath(sessionKey);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch (err) {
    console.error(
      `[session-checkpoint] Failed to delete checkpoint for ${sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * List all available checkpoints
 */
export function listCheckpoints(): SessionCheckpoint[] {
  try {
    const dir = getCheckpointDir();
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const checkpoints: SessionCheckpoint[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(dir, file), "utf8");
        const parsedData = JSON.parse(data);
        if (isValidCheckpoint(parsedData)) {
          checkpoints.push(parsedData);
        } else {
          console.warn(`[session-checkpoint] Skipping invalid checkpoint file: ${file}`);
        }
      } catch (err) {
        console.warn(`[session-checkpoint] Skipping unreadable checkpoint file: ${file}`);
      }
    }

    // Sort by timestamp, newest first
    checkpoints.sort((a, b) => b.timestamp - a.timestamp);
    return checkpoints;
  } catch (err) {
    console.error(
      `[session-checkpoint] Failed to list checkpoints:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Clean up old checkpoints
 * @param options Cleanup configuration options
 */
export function cleanupOldCheckpoints(options: CheckpointCleanupOptions = {}): void {
  const { maxAgeMs = 7 * 24 * 60 * 60 * 1000, dryRun = false } = options;
  try {
    const dir = getCheckpointDir();
    if (!fs.existsSync(dir)) {
      return;
    }

    const now = Date.now();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const filepath = path.join(dir, file);
      try {
        const stat = fs.statSync(filepath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (!dryRun) {
            fs.unlinkSync(filepath);
          }
        }
      } catch (err) {
        // Ignore cleanup errors for individual files
      }
    }
  } catch (err) {
    console.error(
      `[session-checkpoint] Error during cleanup:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Create a checkpoint for the current operation
 * @param sessionKey Unique identifier for the session
 * @param operation Name of the operation being checkpointed
 * @param state Arbitrary state data to persist - must be JSON serializable
 * @param breadcrumbs Optional breadcrumb trail for debugging complex operations
 * @returns New checkpoint object with current timestamp
 */
export function createCheckpoint(
  sessionKey: string,
  operation: string,
  state: Record<string, unknown>,
  breadcrumbs?: string[],
): SessionCheckpoint {
  return {
    sessionKey,
    timestamp: Date.now(),
    operation,
    state,
    breadcrumbs,
  };
}

/**
 * Update state in an existing checkpoint
 * @param sessionKey Session identifier to update
 * @param updates State updates to merge into existing checkpoint state
 */
export function updateCheckpointState(sessionKey: string, updates: Record<string, unknown>): void {
  try {
    const checkpoint = restoreCheckpoint(sessionKey);
    if (!checkpoint) {
      return;
    }

    checkpoint.state = { ...checkpoint.state, ...updates };
    checkpoint.timestamp = Date.now();

    saveCheckpoint(checkpoint);
  } catch (err) {
    console.error(
      `[session-checkpoint] Failed to update checkpoint for ${sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
