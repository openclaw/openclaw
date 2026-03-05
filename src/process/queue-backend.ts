/**
 * Unified queue backend entry point — selects memory or persistent (SQLite) backend based on runtime mode.
 *
 * Defaults to memory backend (zero dependencies); switches to SQLite when user configures queue.mode = "persistent".
 *
 * Usage:
 *   import { queueBackend, setQueueMode } from './queue-backend.js';
 *   await setQueueMode('persistent');
 *   queueBackend().insertTask(...)
 */

import type { TaskRecord, TaskStatus } from "./queue-db.js";
import * as memoryBackend from "./queue-memory.js";

export type QueueMode = "memory" | "persistent";

export interface QueueBackendAPI {
  insertTask(lane: string, taskType: string, payload: any): number;
  claimNextPendingTask(lane: string): TaskRecord | null;
  resolveTask(id: number, result?: unknown): void;
  rejectTask(id: number, errorMsg: string): void;
  countQueueByStatus(lane?: string, status?: TaskStatus): number;
  countTotalQueue(): number;
  clearLaneTasks(lane: string): number;
  getPendingTaskIdsForLane(lane: string): number[];
  hasActiveTasks(): boolean;
  recoverRunningTasks(): string[];
  getTaskResult(
    id: number,
  ): { status: TaskStatus; result: unknown; error_msg: string | null } | null;
  getPendingLanes(): string[];
  markStaleTasks(reason?: string): number;
  getRecoverableTasks(): TaskRecord[];
}

let currentMode: QueueMode = "memory";
let persistentBackend: QueueBackendAPI | null = null;

/**
 * Set the queue mode. Should be called in preaction.ts (one-time setup at startup).
 * Dynamically loads the better-sqlite3 module when switching to persistent mode.
 *
 * Note: This function must be called before any enqueue operations.
 */
export async function setQueueMode(mode: QueueMode, dbPath?: string): Promise<void> {
  currentMode = mode;
  if (mode === "persistent" && !persistentBackend) {
    try {
      const db = await import("./queue-db.js");
      if (dbPath) {
        db.initQueueDB(dbPath);
      } else {
        db.initQueueDB();
      }
      persistentBackend = db as unknown as QueueBackendAPI;
    } catch (err) {
      currentMode = "memory";
      console.warn(
        `[queue-backend] Failed to initialize persistent queue, falling back to memory: ${String(err)}`,
      );
    }
  }
}

export function getQueueMode(): QueueMode {
  return currentMode;
}

/**
 * Get the current active queue backend instance.
 */
export function queueBackend(): QueueBackendAPI {
  if (currentMode === "persistent" && persistentBackend) {
    return persistentBackend;
  }
  return memoryBackend as QueueBackendAPI;
}

/**
 * Reset backend state (used for test isolation only).
 */
export function _resetBackendForTests(): void {
  currentMode = "memory";
  persistentBackend = null;
}
