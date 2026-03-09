/**
 * Chain Memory Backend - 异步写入队列
 *
 * 处理次要 provider 的异步写入操作
 *
 * @module async-queue
 * @author Tutu
 * @date 2026-03-09
 */

import type { AsyncWriteTask, DeadLetterItem } from "./types";

/**
 * 异步队列配置
 */
export interface AsyncQueueConfig {
  maxConcurrent: number; // 最大并发数，默认 10
  retryDelayMs: number; // 重试延迟，默认 1000ms
  maxRetries: number; // 最大重试次数，默认 3
  deadLetterMaxSize: number; // 死信队列最大大小，默认 1000
}

/**
 * 队列处理器
 */
export type QueueProcessor = (task: AsyncWriteTask) => Promise<void>;

/**
 * 异步写入队列
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
   * 设置处理器
   */
  setProcessor(processor: QueueProcessor): void {
    this.processor = processor;
  }

  /**
   * 添加任务到队列
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

    // 触发处理
    void this.processQueue();

    return task.id;
  }

  /**
   * 处理队列
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

        // 检查是否超过最大重试次数
        if (task.attempts >= task.maxAttempts) {
          this.moveToDeadLetter(task, "Max retries exceeded");
          continue;
        }

        // 处理任务
        this.processing.add(task.id);
        void this.executeTask(task);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: AsyncWriteTask): Promise<void> {
    if (!this.processor) {
      return;
    }

    try {
      task.attempts++;
      await this.processor(task);

      // 成功
      this.processing.delete(task.id);
    } catch (error) {
      // 失败
      this.processing.delete(task.id);

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (task.attempts < task.maxAttempts) {
        // 重试
        setTimeout(() => {
          this.queue.unshift(task); // 放回队列头部
          void this.processQueue();
        }, this.config.retryDelayMs);
      } else {
        // 超过重试次数，移到死信队列
        this.moveToDeadLetter(task, errorMessage);
      }
    }
  }

  /**
   * 移动到死信队列
   */
  private moveToDeadLetter(task: AsyncWriteTask, error: string): void {
    const deadLetterItem: DeadLetterItem = {
      ...task,
      error,
      failedAt: Date.now(),
    };

    // 检查死信队列大小
    if (this.deadLetterQueue.length >= this.config.deadLetterMaxSize) {
      // 移除最老的项
      this.deadLetterQueue.shift();
    }

    this.deadLetterQueue.push(deadLetterItem);

    // 记录日志
    console.error(`Task ${task.id} moved to dead letter queue:`, error);
  }

  /**
   * 获取队列状态
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
   * 获取死信队列
   */
  getDeadLetterQueue(): DeadLetterItem[] {
    return [...this.deadLetterQueue];
  }

  /**
   * 重试死信队列中的项
   */
  retryDeadLetter(taskId: string): boolean {
    const index = this.deadLetterQueue.findIndex((item) => item.id === taskId);
    if (index === -1) {
      return false;
    }

    const item = this.deadLetterQueue[index];
    this.deadLetterQueue.splice(index, 1);

    // 重置尝试次数并重新入队
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
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    this.processing.clear();
  }

  /**
   * 清空死信队列
   */
  clearDeadLetter(): void {
    this.deadLetterQueue = [];
  }

  /**
   * 等待所有任务完成
   */
  async drain(): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.queue.length === 0 && this.processing.size === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * 获取配置
   */
  getConfig(): AsyncQueueConfig {
    return { ...this.config };
  }
}
