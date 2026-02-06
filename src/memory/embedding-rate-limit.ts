type RateLimiterOptions = {
  maxConcurrency?: number;
  minSpacingMs?: number;
  backoffStepsMs?: number[];
  maxBackoffMs?: number;
};

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MIN_SPACING_MS = 0;
const DEFAULT_BACKOFF_STEPS_MS = [500, 2500, 5000];
const DEFAULT_MAX_BACKOFF_MS = 8000;

const LIMITERS = new Map<string, SharedEmbeddingRateLimiter>();

export function getEmbeddingRateLimiter(key: string): SharedEmbeddingRateLimiter {
  const existing = LIMITERS.get(key);
  if (existing) {
    return existing;
  }
  const limiter = new SharedEmbeddingRateLimiter();
  LIMITERS.set(key, limiter);
  return limiter;
}

export function resetEmbeddingRateLimitersForTest(): void {
  LIMITERS.clear();
}

export class SharedEmbeddingRateLimiter {
  private readonly maxConcurrency: number;
  private readonly minSpacingMs: number;
  private readonly backoffStepsMs: number[];
  private readonly maxBackoffMs: number;

  private active = 0;
  private waiters: Array<() => void> = [];
  private nextAllowedAt = 0;
  private backoffStep = 0;
  private startLock: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.minSpacingMs = Math.max(0, options.minSpacingMs ?? DEFAULT_MIN_SPACING_MS);
    this.backoffStepsMs = (options.backoffStepsMs ?? DEFAULT_BACKOFF_STEPS_MS)
      .map((value) => Math.max(0, value))
      .filter((value) => Number.isFinite(value));
    this.maxBackoffMs = Math.max(0, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitForStartWindow();
      return await fn();
    } finally {
      this.release();
    }
  }

  noteRateLimit(retryAfterMs?: number): void {
    const now = Date.now();
    const step = Math.min(this.backoffStep, this.backoffStepsMs.length - 1);
    const baseDelay = this.backoffStepsMs[step] ?? this.backoffStepsMs.at(-1) ?? 0;
    const desired = Math.max(baseDelay, retryAfterMs ?? 0);
    const delay = Math.min(this.maxBackoffMs, desired);
    this.backoffStep = Math.min(this.backoffStep + 1, this.backoffStepsMs.length - 1);
    this.nextAllowedAt = Math.max(this.nextAllowedAt, now + delay);
  }

  noteSuccess(): void {
    this.backoffStep = 0;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  private async waitForStartWindow(): Promise<void> {
    const prev = this.startLock;
    let release!: () => void;
    this.startLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAllowedAt - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      const nextSpacing = this.minSpacingMs > 0 ? this.minSpacingMs : 0;
      this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + nextSpacing);
    } finally {
      release();
    }
  }
}

async function sleep(durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
