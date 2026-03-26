import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

export enum EmbeddingPriority {
  HIGH = 0,
  MEDIUM = 1,
  LOW = 2,
}

export class EmbeddingDroppedError extends Error {
  readonly priority: EmbeddingPriority;
  readonly dropReason: "bucket_empty" | "queue_full" | "queue_timeout";

  constructor(params: {
    priority: EmbeddingPriority;
    dropReason: "bucket_empty" | "queue_full" | "queue_timeout";
    message?: string;
  }) {
    super(
      params.message ??
        `embedding request dropped: priority=${EmbeddingPriority[params.priority]} reason=${params.dropReason}`,
    );
    this.name = "EmbeddingDroppedError";
    this.priority = params.priority;
    this.dropReason = params.dropReason;
  }
}

const DEFAULT_CAPACITY = 1000;
const DEFAULT_REFILL_RATE = 1000; // tokens per minute
const DEFAULT_REFILL_INTERVAL_MS = 1000;
const DEFAULT_COOLDOWN_THRESHOLD = 50;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;
const DEFAULT_THROTTLE_PENALTY_SECONDS = 60;

type QueueEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class GeminiEmbeddingRateLimiter {
  private _tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly refillIntervalMs: number;
  private readonly cooldownThreshold: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private refillTimer: NodeJS.Timeout | null = null;
  private refillPausedUntil = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(params?: {
    capacity?: number;
    refillRate?: number;
    refillIntervalMs?: number;
    cooldownThreshold?: number;
    maxQueueSize?: number;
    queueTimeoutMs?: number;
  }) {
    this.capacity = params?.capacity ?? DEFAULT_CAPACITY;
    this.refillRate = params?.refillRate ?? DEFAULT_REFILL_RATE;
    this.refillIntervalMs = params?.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;
    this.cooldownThreshold = params?.cooldownThreshold ?? DEFAULT_COOLDOWN_THRESHOLD;
    this.maxQueueSize = params?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.queueTimeoutMs = params?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this._tokens = this.capacity;
    this.startRefill();
  }

  get tokens(): number {
    return this._tokens;
  }

  async acquire(priority: EmbeddingPriority): Promise<void> {
    if (process.env.OPENCLAW_TEST_FAST === "1") {
      return;
    }

    // Tokens available -- pass immediately
    if (this._tokens > 0) {
      // LOW gets dropped when at or below threshold
      if (priority === EmbeddingPriority.LOW && this._tokens <= this.cooldownThreshold) {
        log.warn(
          `memory embeddings: rate limited, dropping LOW priority request (tokens=${this._tokens}/${this.capacity})`,
        );
        throw new EmbeddingDroppedError({ priority, dropReason: "bucket_empty" });
      }
      // MEDIUM gets dropped when at or below threshold
      if (priority === EmbeddingPriority.MEDIUM && this._tokens <= this.cooldownThreshold) {
        log.warn(
          `memory embeddings: rate limited, dropping MEDIUM priority request (tokens=${this._tokens}/${this.capacity})`,
        );
        throw new EmbeddingDroppedError({ priority, dropReason: "bucket_empty" });
      }
      this._tokens -= 1;
      return;
    }

    // Bucket empty
    if (priority === EmbeddingPriority.LOW) {
      log.warn(
        `memory embeddings: rate limited, dropping LOW priority request (tokens=0/${this.capacity})`,
      );
      throw new EmbeddingDroppedError({ priority, dropReason: "bucket_empty" });
    }

    if (priority === EmbeddingPriority.MEDIUM) {
      log.warn(
        `memory embeddings: rate limited, dropping MEDIUM priority request (tokens=0/${this.capacity})`,
      );
      throw new EmbeddingDroppedError({ priority, dropReason: "bucket_empty" });
    }

    // HIGH priority -- queue
    if (this.queue.length >= this.maxQueueSize) {
      log.warn(
        `memory embeddings: rate limited, queue full, dropping HIGH priority request (queue=${this.queue.length}/${this.maxQueueSize})`,
      );
      throw new EmbeddingDroppedError({ priority, dropReason: "queue_full" });
    }

    log.warn(
      `memory embeddings: rate limited, queuing HIGH priority request (tokens=0/${this.capacity}, queue=${this.queue.length + 1}/${this.maxQueueSize})`,
    );

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(
          new EmbeddingDroppedError({
            priority,
            dropReason: "queue_timeout",
            message: `embedding request timed out in queue after ${this.queueTimeoutMs}ms`,
          }),
        );
      }, this.queueTimeoutMs);
      // Don't block process exit
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      this.queue.push({ resolve, reject, timer });
    });
  }

  reportThrottled(retryAfterSeconds?: number): void {
    const penalty = retryAfterSeconds ?? DEFAULT_THROTTLE_PENALTY_SECONDS;
    this._tokens = 0;
    this.refillPausedUntil = Date.now() + penalty * 1000;
    log.warn(
      `memory embeddings: rate limit cooldown from 429 (retry-after=${penalty}s, refill paused)`,
    );
  }

  dispose(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error("rate limiter disposed"));
    }
    this.queue.length = 0;
  }

  private startRefill(): void {
    if (this.refillTimer) {
      return;
    }
    const tokensPerTick = this.refillRate / (60_000 / this.refillIntervalMs);
    let fractional = 0;
    this.refillTimer = setInterval(() => {
      if (Date.now() < this.refillPausedUntil) {
        return;
      }
      fractional += tokensPerTick;
      const whole = Math.floor(fractional);
      if (whole <= 0) {
        return;
      }
      fractional -= whole;
      const added = Math.min(whole, this.capacity - this._tokens);
      this._tokens += added;

      // Drain queue entries
      while (this.queue.length > 0 && this._tokens > 0) {
        const entry = this.queue.shift()!;
        clearTimeout(entry.timer);
        this._tokens -= 1;
        entry.resolve();
      }
    }, this.refillIntervalMs);
    // Don't block process exit
    if (this.refillTimer && typeof this.refillTimer === "object" && "unref" in this.refillTimer) {
      this.refillTimer.unref();
    }
  }
}

// --- Singleton registry keyed by API key hash ---

const LIMITER_REGISTRY = new Map<string, GeminiEmbeddingRateLimiter>();

export function getOrCreateLimiter(apiKeyHash: string): GeminiEmbeddingRateLimiter {
  let limiter = LIMITER_REGISTRY.get(apiKeyHash);
  if (!limiter) {
    limiter = new GeminiEmbeddingRateLimiter();
    LIMITER_REGISTRY.set(apiKeyHash, limiter);
  }
  return limiter;
}

export async function acquireEmbeddingSlot(
  apiKeyHash: string,
  priority: EmbeddingPriority,
): Promise<void> {
  const limiter = getOrCreateLimiter(apiKeyHash);
  return limiter.acquire(priority);
}

export function reportThrottled(apiKeyHash: string, retryAfterSeconds?: number): void {
  const limiter = LIMITER_REGISTRY.get(apiKeyHash);
  if (limiter) {
    limiter.reportThrottled(retryAfterSeconds);
  }
}

/** Map sync reason to embedding priority. */
export function reasonToPriority(reason?: string): EmbeddingPriority {
  switch (reason) {
    case "search":
    case "fallback":
      return EmbeddingPriority.HIGH;
    case "session-delta":
      return EmbeddingPriority.MEDIUM;
    case "session-start":
    case "watch":
    case "interval":
    default:
      return EmbeddingPriority.LOW;
  }
}

/** Dispose all limiters (for tests/shutdown). */
export function disposeAllLimiters(): void {
  for (const limiter of LIMITER_REGISTRY.values()) {
    limiter.dispose();
  }
  LIMITER_REGISTRY.clear();
}
