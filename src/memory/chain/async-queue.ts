/**
 * Chain Memory Backend - Async Write Queue
 *
 * Handles async write operations for secondary providers
 *
 * @module async-queue
 * @author Tutu
 * @date 2026-03-09
 */

import type { AsyncWriteTask, DeadLetterItem } from "./types";

/**
 * Async Queue Configuration
 */
export interface AsyncQueueConfig {
  maxConcurrent: number; // Max concurrent tasks, default 10
  retryDelayMs: number; // Retry delay, default 1000ms
  maxRetries: number; // Max retries, default 3
  deadLetterMaxSize: number; // Max dead letter queue size, default 1000
}

/**
 * Queue Processor
 */
export type QueueProcessor = (task: AsyncWriteTask) => Promise<void>;

/**
 * Async Write Queue
 */
export class AsyncWriteQueue {
  private config: AsyncQueueConfig;
  private queue: AsyncWriteTask[] = [];
  private deadLetterQueue: DeadLetterItem[] = [];
  private processing: Set<string> = new Set();
  private processor?: QueueProcessor;
  private isProcessing: boolean = false;
  private taskIdCounter: number = 0;

  constructor(config: Partial<AsyncQueueConfig> = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 10,
      retryDelayMs: config.retryDelayMs ?? 1000,
      maxRetries: config.maxRetries ?? 3,
      deadLetterMaxSize: config.deadLetterMaxSize ?? 1000,
    };
  }

  /**
   * Set processor
   */
  setProcessor(processor: QueueProcessor): void {
    this.processor = processor;
  }

  /**
   * Add task to queue
   */
  enqueue(providerName: string, operation: "add" | "update" | "delete", data: unknown): string {
    const task: AsyncWriteTask = {
      id: `task-${++this.taskIdCounter}`,
      providerName,
      operation,
      data,
      timestamp: Date.now(),
      attempts: 0,
      maxAttempts: this.config.maxRetries,
    };

    this.queue.push(task);

    // Trigger processing
    void this.processQueue();

    return task.id;
  }

  /**
   * Process queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || !this.processor) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && this.processing.size < this.config.maxConcurrent) {
        const task = this.queue.shift();
        if (!task) {
          break;
        }

        // Check if max retries exceeded
        if (task.attempts >= task.maxAttempts) {
          this.moveToDeadLetter(task, "Max retries exceeded");
          continue;
        }

        // Process task
        this.processing.add(task.id);
        void this.executeTask(task);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute single task
   */
  private async executeTask(task: AsyncWriteTask): Promise<void> {
    if (!this.processor) {
      return;
    }

    try {
      task.attempts++;
      await this.processor(task);

      // Success
      this.processing.delete(task.id);
    } catch (error) {
      // Failure
      this.processing.delete(task.id);

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (task.attempts < task.maxAttempts) {
        // Retry
        setTimeout(() => {
          this.queue.unshift(task); // Put back at queue head
          void this.processQueue();
        }, this.config.retryDelayMs);
      } else {
        // Exceeded attempts, move to dead letter queue
        this.moveToDeadLetter(task, errorMessage);
      }
    }
  }

  /**
   * Move to dead letter queue
   */
  private moveToDeadLetter(task: AsyncWriteTask, error: string): void {
    const deadLetterItem: DeadLetterItem = {
      ...task,
      error,
      failedAt: Date.now(),
    };

    // Check dead letter queue size
    if (this.deadLetterQueue.length >= this.config.deadLetterMaxSize) {
      // Remove oldest item
      this.deadLetterQueue.shift();
    }

    this.deadLetterQueue.push(deadLetterItem);

    // Log
    console.error(`Task ${task.id} moved to dead letter queue:`, error);
  }

  /**
   * Get queue status
   */
  getStatus(): {
    pending: number;
    processing: number;
    deadLetter: number;
  } {
    return {
      pending: this.queue.length,
      processing: this.processing.size,
      deadLetter: this.deadLetterQueue.length,
    };
  }

  /**
   * Get dead letter queue
   */
  getDeadLetterQueue(): DeadLetterItem[] {
    return [...this.deadLetterQueue];
  }

  /**
   * RetryItems in dead letter queue
   */
  retryDeadLetter(taskId: string): boolean {
    const index = this.deadLetterQueue.findIndex((item) => item.id === taskId);
    if (index === -1) {
      return false;
    }

    const item = this.deadLetterQueue[index];
    this.deadLetterQueue.splice(index, 1);

    // Reset attempts and re-enqueue
    const task: AsyncWriteTask = {
      id: item.id,
      providerName: item.providerName,
      operation: item.operation,
      data: item.data,
      timestamp: Date.now(),
      attempts: 0,
      maxAttempts: item.maxAttempts,
    };

    this.queue.push(task);
    void this.processQueue();

    return true;
  }

  /**
   * Clear queue
   */
  clear(): void {
    this.queue = [];
    this.processing.clear();
  }

  /**
   * Clear dead letter queue
   */
  clearDeadLetter(): void {
    this.deadLetterQueue = [];
  }

  /**
   * Wait for all tasks to complete
   * @param timeoutMs - Timeout in milliseconds, default 30s. Set to 0 for no timeout
   */
  async drain(timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        // Check if queue is empty
        if (this.queue.length === 0 && this.processing.size === 0) {
          clearInterval(checkInterval);
          resolve();
          return;
        }

        // Check if timeout
        if (timeoutMs > 0 && Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(
            new Error(
              `Drain timeout exceeded after ${timeoutMs}ms. ` +
                `Remaining: ${this.queue.length} queued, ${this.processing.size} processing`,
            ),
          );
        }
      }, 100);
    });
  }

  /**
   * Get configuration
   */
  getConfig(): AsyncQueueConfig {
    return { ...this.config };
  }
}
