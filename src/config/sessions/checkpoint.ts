/**
 * Session checkpoint and restore functionality.
 *
 * Provides full checkpoint/restore architecture for session state and transcripts.
 * Checkpoints are created before session resets or GC deletion to enable recovery.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveUserPath } from "../../utils.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

export interface SessionCheckpoint {
  id: string; // UUID
  sessionId: string;
  sessionKey: string;
  agentId: string;
  transcriptPath: string;
  metadata: SessionEntry;
  timestamp: number;
  reason: "pre-reset" | "pre-gc" | "manual";
}

/**
 * Resolve the checkpoint directory for an agent.
 */
function resolveCheckpointDir(agentId: string): string {
  return resolveUserPath(`~/.moltbot/agents/${agentId}/checkpoints`);
}

/**
 * Resolve the path to a session transcript file.
 */
function resolveSessionTranscriptPath(agentId: string, sessionId: string): string {
  return resolveUserPath(`~/.moltbot/agents/${agentId}/sessions/${sessionId}.jsonl`);
}

/**
 * Resolve the path to the sessions store for an agent.
 */
function resolveSessionStorePath(agentId: string): string {
  return resolveUserPath(`~/.moltbot/agents/${agentId}/sessions/sessions.json`);
}

/**
 * Create a checkpoint of a session before reset or deletion.
 *
 * @param agentId - The agent ID (e.g., "liam-telegram")
 * @param sessionKey - The session key (e.g., "user:123" or "global")
 * @param sessionEntry - The session entry metadata
 * @param reason - Why the checkpoint is being created
 * @returns The created checkpoint
 */
export async function createSessionCheckpoint(
  agentId: string,
  sessionKey: string,
  sessionEntry: SessionEntry,
  reason: "pre-reset" | "pre-gc" | "manual",
): Promise<SessionCheckpoint> {
  const checkpointId = crypto.randomUUID();
  const checkpointDir = resolveCheckpointDir(agentId);

  // 1. Create checkpoint directory if needed
  await fs.mkdir(checkpointDir, { recursive: true });

  // 2. Copy transcript file
  const sourceTranscriptPath = resolveSessionTranscriptPath(agentId, sessionEntry.sessionId);
  const checkpointTranscriptPath = path.join(checkpointDir, `${checkpointId}.jsonl`);

  let transcriptCopied = false;
  try {
    await fs.access(sourceTranscriptPath);
    await fs.copyFile(sourceTranscriptPath, checkpointTranscriptPath);
    transcriptCopied = true;
  } catch {
    // Transcript doesn't exist or can't be accessed
    // Still create checkpoint with metadata
  }

  // 3. Save checkpoint manifest
  const checkpoint: SessionCheckpoint = {
    id: checkpointId,
    sessionId: sessionEntry.sessionId,
    sessionKey,
    agentId,
    transcriptPath: transcriptCopied ? checkpointTranscriptPath : "",
    metadata: JSON.parse(JSON.stringify(sessionEntry)), // Deep clone
    timestamp: Date.now(),
    reason,
  };

  const manifestPath = path.join(checkpointDir, `${checkpointId}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(checkpoint, null, 2));

  console.log(
    `[checkpoint] Created checkpoint ${checkpointId} for session ${sessionKey} (${agentId}): reason=${reason}`,
  );

  return checkpoint;
}

/**
 * Restore a session from a checkpoint.
 *
 * @param checkpoint - The checkpoint to restore
 */
export async function restoreSessionCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
  // 1. Validate checkpoint transcript exists
  if (checkpoint.transcriptPath) {
    try {
      await fs.access(checkpoint.transcriptPath);
    } catch {
      throw new Error(
        `Checkpoint transcript not found: ${checkpoint.transcriptPath}. Checkpoint may be corrupted.`,
      );
    }
  }

  // 2. Restore transcript file
  if (checkpoint.transcriptPath) {
    const targetPath = resolveSessionTranscriptPath(checkpoint.agentId, checkpoint.sessionId);
    await fs.copyFile(checkpoint.transcriptPath, targetPath);
    console.log(`[checkpoint] Restored transcript: ${targetPath}`);
  }

  // 3. Restore session metadata
  const storePath = resolveSessionStorePath(checkpoint.agentId);
  await updateSessionStore(storePath, (store) => {
    store[checkpoint.sessionKey] = checkpoint.metadata;
  });

  console.log(
    `[checkpoint] Restored session ${checkpoint.sessionKey} from checkpoint ${checkpoint.id}`,
  );
}

/**
 * List all checkpoints for an agent.
 *
 * @param agentId - The agent ID
 * @returns Array of checkpoints, sorted by timestamp (newest first)
 */
export async function listSessionCheckpoints(agentId: string): Promise<SessionCheckpoint[]> {
  const checkpointDir = resolveCheckpointDir(agentId);

  try {
    await fs.access(checkpointDir);
  } catch {
    // Checkpoint directory doesn't exist
    return [];
  }

  const files = await fs.readdir(checkpointDir);
  const manifestFiles = files.filter((f) => f.endsWith(".json"));

  const checkpoints: SessionCheckpoint[] = [];

  for (const file of manifestFiles) {
    try {
      const manifestPath = path.join(checkpointDir, file);
      const content = await fs.readFile(manifestPath, "utf-8");
      const checkpoint = JSON.parse(content) as SessionCheckpoint;
      checkpoints.push(checkpoint);
    } catch {
      // Skip invalid checkpoint files
    }
  }

  // Sort by timestamp (newest first)
  checkpoints.sort((a, b) => b.timestamp - a.timestamp);

  return checkpoints;
}

/**
 * Get a specific checkpoint by ID.
 *
 * @param agentId - The agent ID
 * @param checkpointId - The checkpoint ID
 * @returns The checkpoint, or undefined if not found
 */
export async function getSessionCheckpoint(
  agentId: string,
  checkpointId: string,
): Promise<SessionCheckpoint | undefined> {
  const checkpoints = await listSessionCheckpoints(agentId);
  return checkpoints.find((c) => c.id === checkpointId);
}

/**
 * Delete a checkpoint.
 *
 * @param agentId - The agent ID
 * @param checkpointId - The checkpoint ID
 */
export async function deleteSessionCheckpoint(
  agentId: string,
  checkpointId: string,
): Promise<void> {
  const checkpoint = await getSessionCheckpoint(agentId, checkpointId);
  if (!checkpoint) {
    throw new Error(`Checkpoint not found: ${checkpointId}`);
  }

  const checkpointDir = resolveCheckpointDir(agentId);

  // Delete manifest
  const manifestPath = path.join(checkpointDir, `${checkpointId}.json`);
  try {
    await fs.unlink(manifestPath);
  } catch {
    // Ignore if already deleted
  }

  // Delete transcript
  if (checkpoint.transcriptPath) {
    try {
      await fs.unlink(checkpoint.transcriptPath);
    } catch {
      // Ignore if already deleted
    }
  }

  console.log(`[checkpoint] Deleted checkpoint ${checkpointId}`);
}

/**
 * Clean up old checkpoints.
 *
 * @param agentId - The agent ID
 * @param maxAgeDays - Maximum age of checkpoints to keep (default: 7 days)
 * @returns Number of checkpoints deleted
 */
export async function cleanupOldCheckpoints(
  agentId: string,
  maxAgeDays: number = 7,
): Promise<number> {
  const checkpoints = await listSessionCheckpoints(agentId);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;

  for (const checkpoint of checkpoints) {
    if (checkpoint.timestamp < cutoff) {
      try {
        await deleteSessionCheckpoint(agentId, checkpoint.id);
        deleted++;
      } catch {
        // Ignore errors during cleanup
      }
    }
  }

  if (deleted > 0) {
    console.log(`[checkpoint] Cleaned up ${deleted} old checkpoints for agent ${agentId}`);
  }

  return deleted;
}

/**
 * Clean up old checkpoints for all agents.
 *
 * @param maxAgeDays - Maximum age of checkpoints to keep (default: 7 days)
 * @returns Total number of checkpoints deleted
 */
export async function cleanupAllOldCheckpoints(maxAgeDays: number = 7): Promise<number> {
  const stateDir = resolveUserPath("~/.moltbot");
  const agentsDir = path.join(stateDir, "agents");

  try {
    await fs.access(agentsDir);
  } catch {
    // Agents directory doesn't exist
    return 0;
  }

  const agentDirEntries = await fs.readdir(agentsDir, { withFileTypes: true });
  const agentIds = agentDirEntries.filter((e) => e.isDirectory()).map((e) => e.name);

  let totalDeleted = 0;

  for (const agentId of agentIds) {
    try {
      const deleted = await cleanupOldCheckpoints(agentId, maxAgeDays);
      totalDeleted += deleted;
    } catch {
      // Ignore errors for individual agents
    }
  }

  return totalDeleted;
}
