/**
 * Background Work Executor
 *
 * Polls SQLite for ready work items and executes them on a dedicated
 * command queue lane. Chat message handling runs on a separate lane
 * and is never blocked by work execution.
 */

import { EventEmitter } from "node:events";
import type { ParallelSessionManager, WorkItem } from "./parallel-session-manager.js";

export interface WorkExecutorConfig {
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs: number;
  /** Max concurrent work items executing (default: 1) */
  maxConcurrent: number;
  /** Max execution time per work item in ms (default: 300000 = 5 min) */
  executionTimeoutMs: number;
}

export const DEFAULT_WORK_EXECUTOR_CONFIG: WorkExecutorConfig = {
  pollIntervalMs: 5_000,
  maxConcurrent: 1,
  executionTimeoutMs: 300_000,
};

/**
 * Handler function for executing work items.
 * Receives an AbortSignal to cooperatively cancel on timeout.
 */
export type WorkHandler = (
  item: WorkItem,
  context: {
    updateProgress: (pct: number) => Promise<void>;
    isCancelled: () => Promise<boolean>;
    /** AbortSignal — aborted when execution times out or is cancelled */
    signal: AbortSignal;
  },
) => Promise<{ summary: string }>;

/**
 * Executes background work items from the shared SQLite queue.
 * Designed to coexist with the chat responder without blocking it.
 */
export class WorkExecutor extends EventEmitter {
  private config: WorkExecutorConfig;
  private manager: ParallelSessionManager;
  private handler: WorkHandler;
  private pollTimer?: ReturnType<typeof setInterval>;
  private activeCount = 0;
  private stopped = true; // starts stopped until start() is called

  constructor(
    manager: ParallelSessionManager,
    handler: WorkHandler,
    config: Partial<WorkExecutorConfig> = {},
  ) {
    super();
    this.manager = manager;
    this.handler = handler;
    this.config = { ...DEFAULT_WORK_EXECUTOR_CONFIG, ...config };
  }

  /**
   * Start polling for ready work
   */
  start(): void {
    if (this.pollTimer) {
      return;
    }

    this.stopped = false;
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => {
        this.emit("error", err);
      });
    }, this.config.pollIntervalMs);

    // Run immediately on start
    this.tick().catch((err) => {
      this.emit("error", err);
    });

    this.emit("started");
  }

  /**
   * Stop polling (in-flight work completes)
   */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.emit("stopped");
  }

  /**
   * Single poll + execute cycle.
   * Uses claimReadyWork() (atomic transaction) to prevent duplicate execution.
   */
  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.activeCount >= this.config.maxConcurrent) {
      return;
    }

    const slots = this.config.maxConcurrent - this.activeCount;
    // claimReadyWork atomically transitions items to "executing" — no race condition
    const items = await this.manager.claimReadyWork(slots);

    for (const item of items) {
      if (this.stopped || this.activeCount >= this.config.maxConcurrent) {
        break;
      }
      // Fire-and-forget — runs on the event loop alongside chat
      this.executeItem(item).catch((err) => {
        this.emit("error", err);
      });
    }
  }

  /**
   * Execute a single work item with timeout, cancellation, and retry logic.
   *
   * claimReadyWork() already transitions to "executing", so we only update
   * the attempts counter. Uses AbortController to signal handler cancellation
   * on timeout.
   */
  private async executeItem(item: WorkItem): Promise<void> {
    if (!item.id) {
      return;
    }

    this.activeCount++;
    const itemId = item.id;

    try {
      // claimReadyWork() already set status to "executing" and started_at.
      // Just update the attempts counter.
      await this.manager.transitionWork(itemId, "executing", {
        attempts: item.attempts + 1,
      });

      this.emit("work:executing", item);

      // AbortController for cooperative cancellation
      const abortController = new AbortController();

      // Create context for the handler
      const updateProgress = async (pct: number): Promise<void> => {
        // Guard stale writes after timeout/cancellation
        if (abortController.signal.aborted) {
          return;
        }
        await this.manager.transitionWork(itemId, "executing", { progressPct: pct });
      };

      const isCancelled = async (): Promise<boolean> => {
        if (abortController.signal.aborted) {
          return true;
        }
        const items = await this.manager.getWork(item.sessionKey, ["cancelled"]);
        return items.some((w) => w.id === itemId);
      };

      // Launch handler — capture promise reference for orphan suppression
      const handlerPromise = this.handler(item, {
        updateProgress,
        isCancelled,
        signal: abortController.signal,
      });

      // Suppress unhandled rejection on orphaned promise when timeout wins
      handlerPromise.catch(() => {});

      // Execute with timeout
      const result = await Promise.race([
        handlerPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            abortController.abort(); // Signal handler to stop
            reject(new Error(`Work item ${itemId} timed out`));
          }, this.config.executionTimeoutMs),
        ),
      ]);

      await this.manager.transitionWork(itemId, "completed", {
        progressPct: 100,
        resultSummary: result.summary,
      });

      this.emit("work:completed", { id: itemId, summary: result.summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (item.attempts + 1 >= item.maxAttempts) {
        await this.manager.transitionWork(itemId, "failed", {
          resultSummary: `Failed after ${item.attempts + 1} attempts: ${message}`,
        });
        this.emit("work:failed", { id: itemId, error: message, final: true });
      } else {
        // Retry — set back to ready
        await this.manager.transitionWork(itemId, "ready", {
          resultSummary: `Attempt ${item.attempts + 1} failed: ${message}`,
        });
        this.emit("work:failed", { id: itemId, error: message, final: false });
      }
    } finally {
      this.activeCount--;
    }
  }

  /**
   * Get executor status for chat reporting
   */
  getStatus(): {
    running: boolean;
    activeCount: number;
    maxConcurrent: number;
  } {
    return {
      running: !this.stopped,
      activeCount: this.activeCount,
      maxConcurrent: this.config.maxConcurrent,
    };
  }
}

export function createWorkExecutor(
  manager: ParallelSessionManager,
  handler: WorkHandler,
  config?: Partial<WorkExecutorConfig>,
): WorkExecutor {
  return new WorkExecutor(manager, handler, config);
}
