/**
 * Message Queue System
 * Async message processing with rate limiting and retry logic
 */

import { EventEmitter } from "node:events";

export interface MessageQueueOptions {
  concurrency?: number;
  maxRetries?: number;
  rateLimitWindow?: number;
  rateLimitMax?: number;
}

export interface QueueMessage {
  id: string;
  data: unknown;
  priority: "high" | "normal" | "low";
}

export interface QueueStats {
  queued: number;
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  active: number;
  isPaused: boolean;
}

type MessageHandler = (message: QueueMessage) => Promise<unknown>;

interface QueueEntry {
  id: string;
  message: QueueMessage;
  handler: MessageHandler;
  attempts: number;
  enqueuedAt: number;
  scheduledAt: number | null;
}

export class MessageQueue extends EventEmitter {
  private config: Required<MessageQueueOptions>;
  private queues: {
    high: QueueEntry[];
    normal: QueueEntry[];
    low: QueueEntry[];
  } = { high: [], normal: [], low: [] };
  private active: Map<string, QueueEntry> = new Map();
  private isProcessing = false;
  private isPaused = false;
  private rateLimiter: RateLimiter;
  private stats = {
    queued: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
  };

  constructor(options: MessageQueueOptions = {}) {
    super();
    this.config = {
      concurrency: options.concurrency ?? 10,
      maxRetries: options.maxRetries ?? 3,
      rateLimitWindow: options.rateLimitWindow ?? 60000,
      rateLimitMax: options.rateLimitMax ?? 100,
    };
    this.rateLimiter = new RateLimiter({
      window: this.config.rateLimitWindow,
      max: this.config.rateLimitMax,
    });
  }

  enqueue(
    message: QueueMessage,
    handler: MessageHandler,
    options: { delay?: number } = {},
  ): string {
    const entry: QueueEntry = {
      id: message.id || this.generateId(),
      message,
      handler,
      attempts: 0,
      enqueuedAt: Date.now(),
      scheduledAt: options.delay ? Date.now() + options.delay : null,
    };

    const queue = this.queues[message.priority] || this.queues.normal;
    queue.push(entry);
    this.stats.queued++;
    this.emit("enqueue", entry);

    if (!this.isProcessing) {
      void this.process();
    }

    return entry.id;
  }

  private async process(): Promise<void> {
    if (this.isProcessing || this.isPaused) {
      return;
    }

    this.isProcessing = true;
    this.emit("processing-start");

    while (this.hasQueuedMessages() && !this.isPaused) {
      if (this.active.size >= this.config.concurrency) {
        await this.waitForSlot();
        continue;
      }

      if (!this.rateLimiter.canProceed()) {
        await this.waitForRateLimit();
        continue;
      }

      const entry = this.getNextMessage();
      if (!entry) {
        continue;
      }

      if (entry.scheduledAt && Date.now() < entry.scheduledAt) {
        this.queues[entry.message.priority].unshift(entry);
        await this.wait(100);
        continue;
      }

      void this.processMessage(entry);
    }

    this.isProcessing = false;
    this.emit("processing-end");
  }

  private async processMessage(entry: QueueEntry): Promise<void> {
    this.active.set(entry.id, entry);
    this.rateLimiter.record();
    this.emit("message-start", entry);

    try {
      const result = await entry.handler(entry.message);
      this.stats.processed++;
      this.stats.succeeded++;
      this.active.delete(entry.id);
      this.emit("message-complete", { ...entry, result });
    } catch (error) {
      entry.attempts++;

      if (entry.attempts <= this.config.maxRetries) {
        this.stats.retried++;
        const delay = 1000 * Math.pow(2, entry.attempts - 1);
        entry.scheduledAt = Date.now() + delay;
        this.queues[entry.message.priority].push(entry);
        this.emit("message-retry", { ...entry, error, nextAttempt: entry.scheduledAt });
      } else {
        this.stats.failed++;
        this.emit("message-failed", { ...entry, error, attempts: entry.attempts });
      }

      this.active.delete(entry.id);
    }
  }

  private getNextMessage(): QueueEntry | null {
    for (const priority of ["high", "normal", "low"] as const) {
      const queue = this.queues[priority];
      if (queue.length > 0) {
        return queue.shift()!;
      }
    }
    return null;
  }

  private hasQueuedMessages(): boolean {
    return Object.values(this.queues).some((q) => q.length > 0);
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.active.size < this.config.concurrency) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private waitForRateLimit(): Promise<void> {
    const waitTime = Math.min(this.rateLimiter.getTimeUntilReset(), 1000);
    return this.wait(waitTime);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  pause(): void {
    this.isPaused = true;
    this.emit("paused");
  }

  resume(): void {
    this.isPaused = false;
    this.emit("resumed");
    if (!this.isProcessing) {
      void this.process();
    }
  }

  getStats(): QueueStats {
    return {
      ...this.stats,
      queued: Object.values(this.queues).reduce((sum, q) => sum + q.length, 0),
      active: this.active.size,
      isPaused: this.isPaused,
    };
  }

  clear(): void {
    for (const queue of Object.values(this.queues)) {
      queue.length = 0;
    }
    this.emit("cleared");
  }
}

class RateLimiter {
  private window: number;
  private max: number;
  private requests: number[] = [];

  constructor(config: { window: number; max: number }) {
    this.window = config.window;
    this.max = config.max;
  }

  canProceed(): boolean {
    this.cleanup();
    return this.requests.length < this.max;
  }

  record(): void {
    this.requests.push(Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.window;
    this.requests = this.requests.filter((t) => t > cutoff);
  }

  getTimeUntilReset(): number {
    if (this.requests.length === 0) {
      return 0;
    }
    const oldestRequest = Math.min(...this.requests);
    return Math.max(0, oldestRequest + this.window - Date.now());
  }
}

let globalQueue: MessageQueue | null = null;

export function getMessageQueue(options?: MessageQueueOptions): MessageQueue {
  if (!globalQueue) {
    globalQueue = new MessageQueue(options);
  }
  return globalQueue;
}

export function clearMessageQueue(): void {
  globalQueue?.clear();
}
