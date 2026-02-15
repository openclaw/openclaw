/**
 * Session checkpoint/recovery system
 * Saves and restores session state for long operations and gateway restarts
 */

import fs from "fs";
import os from "os";
import path from "path";

export type SessionCheckpoint = {
  sessionKey: string;
  timestamp: number;
  operation: string;
  state: Record<string, any>;
  breadcrumbs?: string[];
};

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
 * Save a checkpoint for a session
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
    const checkpoint = JSON.parse(data) as SessionCheckpoint;

    // Verify checkpoint integrity
    if (!checkpoint.sessionKey || !checkpoint.timestamp || !checkpoint.state) {
      console.warn(`[session-checkpoint] Invalid checkpoint for ${sessionKey}`);
      return null;
    }

    return checkpoint;
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
        const checkpoint = JSON.parse(data) as SessionCheckpoint;
        checkpoints.push(checkpoint);
      } catch (err) {
        console.warn(`[session-checkpoint] Skipping invalid checkpoint file: ${file}`);
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
 * Clean up old checkpoints (older than maxAgeMs)
 */
export function cleanupOldCheckpoints(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
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
          fs.unlinkSync(filepath);
        }
      } catch (err) {
        // Ignore cleanup errors
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
 */
export function createCheckpoint(
  sessionKey: string,
  operation: string,
  state: Record<string, any>,
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
 */
export function updateCheckpointState(sessionKey: string, updates: Record<string, any>): void {
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
