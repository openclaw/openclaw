/**
 * Session Checkpoint/Recovery System
 *
 * Provides periodic session state checkpointing and automatic recovery
 * from interrupted sessions. Preserves conversation context and tool state
 * across restarts.
 */

import fs from "node:fs";
import path from "node:path";

export type SessionCheckpointData = {
  /** Session identifier */
  sessionId: string;
  /** Agent ID that owns this session */
  agentId: string;
  /** Checkpoint creation timestamp */
  createdAt: number;
  /** Number of transcript entries at checkpoint time */
  transcriptLength: number;
  /** Last known cost at checkpoint */
  lastKnownCostUsd?: number;
  /** Last known token count */
  lastKnownTokens?: number;
  /** Active model at checkpoint time */
  activeModel?: string;
  /** Active provider at checkpoint time */
  activeProvider?: string;
  /** Session labels/metadata */
  labels?: Record<string, string>;
  /** Pending tool calls that were in-flight */
  pendingToolCalls?: string[];
  /** Custom metadata from extensions */
  metadata?: Record<string, unknown>;
};

export type CheckpointStoreOptions = {
  /** Directory to store checkpoint files. Default: ~/.openclaw/checkpoints */
  checkpointDir?: string;
  /** Maximum checkpoints to retain per session. Default: 3 */
  maxPerSession?: number;
  /** Minimum interval between checkpoints in ms. Default: 30s */
  minIntervalMs?: number;
};

const DEFAULT_CHECKPOINT_DIR = path.join(
  process.env.HOME ?? "/root",
  ".openclaw",
  "checkpoints",
);
const DEFAULT_MAX_PER_SESSION = 3;
const DEFAULT_MIN_INTERVAL_MS = 30_000;

export class SessionCheckpointStore {
  private readonly checkpointDir: string;
  private readonly maxPerSession: number;
  private readonly minIntervalMs: number;

  /** Tracks last checkpoint time per session to enforce min interval */
  private lastCheckpointTime = new Map<string, number>();

  constructor(options?: CheckpointStoreOptions) {
    this.checkpointDir = options?.checkpointDir ?? DEFAULT_CHECKPOINT_DIR;
    this.maxPerSession = options?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  /**
   * Save a checkpoint for a session.
   * Returns false if min interval hasn't elapsed since last checkpoint.
   */
  async save(data: SessionCheckpointData): Promise<boolean> {
    const now = Date.now();
    const lastTime = this.lastCheckpointTime.get(data.sessionId);
    if (lastTime !== undefined && now - lastTime < this.minIntervalMs) {
      return false;
    }

    await fs.promises.mkdir(this.sessionDir(data.sessionId), { recursive: true });

    const filename = `checkpoint-${now}.json`;
    const filePath = path.join(this.sessionDir(data.sessionId), filename);

    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    this.lastCheckpointTime.set(data.sessionId, now);

    // Prune old checkpoints
    await this.pruneSession(data.sessionId);

    return true;
  }

  /**
   * Load the most recent checkpoint for a session.
   * Returns null if no checkpoint exists.
   */
  async loadLatest(sessionId: string): Promise<SessionCheckpointData | null> {
    const dir = this.sessionDir(sessionId);
    const files = await this.listCheckpointFiles(dir);
    if (files.length === 0) {
      return null;
    }

    // Files are sorted newest-first
    const filePath = path.join(dir, files[0]);
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      return JSON.parse(content) as SessionCheckpointData;
    } catch {
      return null;
    }
  }

  /**
   * List all checkpoints for a session, newest first.
   */
  async listCheckpoints(sessionId: string): Promise<SessionCheckpointData[]> {
    const dir = this.sessionDir(sessionId);
    const files = await this.listCheckpointFiles(dir);
    const results: SessionCheckpointData[] = [];

    for (const file of files) {
      try {
        const content = await fs.promises.readFile(path.join(dir, file), "utf-8");
        results.push(JSON.parse(content) as SessionCheckpointData);
      } catch {
        // Skip corrupted checkpoints
      }
    }

    return results;
  }

  /**
   * Delete all checkpoints for a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.promises.rm(dir, { recursive: true, force: true });
    this.lastCheckpointTime.delete(sessionId);
  }

  /**
   * Find sessions that have checkpoints (for recovery on startup).
   */
  async findRecoverableSessions(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.checkpointDir, {
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  private sessionDir(sessionId: string): string {
    // Sanitize session ID for filesystem use
    const safe = sessionId.replace(/[^a-zA-Z0-9_:.-]/g, "_");
    return path.join(this.checkpointDir, safe);
  }

  private async listCheckpointFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir);
      return entries
        .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .sort()
        .reverse(); // Newest first (timestamp in filename)
    } catch {
      return [];
    }
  }

  private async pruneSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    const files = await this.listCheckpointFiles(dir);

    if (files.length <= this.maxPerSession) {
      return;
    }

    // Remove oldest files beyond the limit
    const toRemove = files.slice(this.maxPerSession);
    for (const file of toRemove) {
      await fs.promises.unlink(path.join(dir, file)).catch(() => {});
    }
  }
}

// Singleton
let defaultStore: SessionCheckpointStore | undefined;

export function getDefaultCheckpointStore(
  options?: CheckpointStoreOptions,
): SessionCheckpointStore {
  if (!defaultStore) {
    defaultStore = new SessionCheckpointStore(options);
  }
  return defaultStore;
}

export function resetDefaultCheckpointStore(): void {
  defaultStore = undefined;
}
