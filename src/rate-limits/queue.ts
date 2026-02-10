/**
 * Rate-limit request queue.
 *
 * When a request is rate-limited, it is placed in a FIFO queue and
 * retried when the rate-limit window resets. This prevents immediate
 * rejection and gives the caller transparent back-pressure.
 */

import type { AcquireResult } from "./types.js";

type QueueEntry<T> = {
    key: string;
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    enqueuedAt: number;
};

export class RateLimitQueue {
    private readonly maxSize: number;
    private readonly timeoutMs: number;
    private readonly queues = new Map<string, QueueEntry<unknown>[]>();
    private drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(params?: { maxSize?: number; timeoutMs?: number }) {
        this.maxSize = params?.maxSize ?? 100;
        this.timeoutMs = params?.timeoutMs ?? 30_000;
    }

    /**
     * Enqueue a request that was rate-limited.
     *
     * @param key       - The rate-limit key (e.g. "openai:rpm").
     * @param retryAfterMs - How long until the window resets.
     * @param acquireFn - Function that re-checks the limiter.
     * @param fn        - The actual work to execute on success.
     */
    enqueue<T>(
        key: string,
        retryAfterMs: number,
        acquireFn: () => AcquireResult,
        fn: () => Promise<T>,
    ): Promise<T> {
        let queue = this.queues.get(key);
        if (!queue) {
            queue = [];
            this.queues.set(key, queue);
        }

        if (queue.length >= this.maxSize) {
            return Promise.reject(
                new RateLimitQueueFullError(
                    `Rate limit queue full for ${key} (max ${this.maxSize})`,
                ),
            );
        }

        const promise = new Promise<T>((resolve, reject) => {
            const entry: QueueEntry<T> = {
                key,
                fn,
                resolve,
                reject,
                enqueuedAt: Date.now(),
            };
            (queue as QueueEntry<unknown>[]).push(entry as QueueEntry<unknown>);
        });

        // Schedule a drain attempt when the rate-limit window resets.
        this.scheduleDrain(key, retryAfterMs, acquireFn);

        return promise;
    }

    /** Get the current queue depth for a key. */
    getQueueDepth(key: string): number {
        return this.queues.get(key)?.length ?? 0;
    }

    /** Get total queued items across all keys. */
    getTotalDepth(): number {
        let total = 0;
        for (const q of this.queues.values()) {
            total += q.length;
        }
        return total;
    }

    /** Drain all queues (reject remaining with timeout). */
    drainAll(): void {
        for (const [key, queue] of this.queues.entries()) {
            for (const entry of queue) {
                entry.reject(new RateLimitQueueTimeoutError(`Queue drained for ${key}`));
            }
            queue.length = 0;
        }
        for (const timer of this.drainTimers.values()) {
            clearTimeout(timer);
        }
        this.drainTimers.clear();
    }

    private scheduleDrain(
        key: string,
        delayMs: number,
        acquireFn: () => AcquireResult,
    ): void {
        if (this.drainTimers.has(key)) {
            return; // Already scheduled.
        }

        const timer = setTimeout(() => {
            this.drainTimers.delete(key);
            this.processDrain(key, acquireFn);
        }, delayMs);

        this.drainTimers.set(key, timer);
    }

    private processDrain(key: string, acquireFn: () => AcquireResult): void {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) {
            return;
        }

        const now = Date.now();

        // Process as many entries as the limiter allows.
        while (queue.length > 0) {
            const entry = queue[0];

            // Check timeout.
            if (now - entry.enqueuedAt > this.timeoutMs) {
                queue.shift();
                entry.reject(
                    new RateLimitQueueTimeoutError(
                        `Request timed out after ${this.timeoutMs}ms in queue for ${key}`,
                    ),
                );
                continue;
            }

            // Try to acquire a slot.
            const result = acquireFn();
            if (!result.allowed) {
                // Still rate-limited — reschedule.
                this.scheduleDrain(key, result.retryAfterMs ?? 1000, acquireFn);
                return;
            }

            // Acquired! Execute the request.
            queue.shift();
            void entry
                .fn()
                .then((value) => entry.resolve(value))
                .catch((err) => entry.reject(err));
        }
    }
}

export class RateLimitQueueFullError extends Error {
    readonly code = "RATE_LIMIT_QUEUE_FULL";
    constructor(message: string) {
        super(message);
        this.name = "RateLimitQueueFullError";
    }
}

export class RateLimitQueueTimeoutError extends Error {
    readonly code = "RATE_LIMIT_QUEUE_TIMEOUT";
    constructor(message: string) {
        super(message);
        this.name = "RateLimitQueueTimeoutError";
    }
}
