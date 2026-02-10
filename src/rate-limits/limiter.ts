/**
 * Sliding-window rate limiter.
 *
 * Uses a fixed-window counter with sliding correction — each key tracks
 * the current window count and the previous window count, then blends them
 * based on the elapsed fraction of the current window. This is simple,
 * memory-efficient, and avoids per-request timestamp storage.
 */

import type { AcquireResult, LimiterWindowState } from "./types.js";

type WindowState = {
    /** Count in the current window. */
    current: number;
    /** Count in the previous window (used for sliding correction). */
    previous: number;
    /** Timestamp (ms) when the current window started. */
    windowStart: number;
};

type LimiterEntry = {
    limit: number;
    windowMs: number;
    state: WindowState;
};

function now(): number {
    return Date.now();
}

function ensureWindow(entry: LimiterEntry): void {
    const elapsed = now() - entry.state.windowStart;
    if (elapsed >= entry.windowMs) {
        // How many full windows have elapsed?
        const windowsPassed = Math.floor(elapsed / entry.windowMs);
        if (windowsPassed >= 2) {
            // Both current and previous are stale.
            entry.state.previous = 0;
            entry.state.current = 0;
        } else {
            // Exactly one window passed — rotate.
            entry.state.previous = entry.state.current;
            entry.state.current = 0;
        }
        entry.state.windowStart += windowsPassed * entry.windowMs;
    }
}

function slidingEstimate(entry: LimiterEntry): number {
    const elapsed = now() - entry.state.windowStart;
    const fraction = Math.min(elapsed / entry.windowMs, 1);
    // Weight previous window by the remaining fraction.
    return entry.state.previous * (1 - fraction) + entry.state.current;
}

export class SlidingWindowLimiter {
    private readonly entries = new Map<string, LimiterEntry>();

    /** Configure a limit for a key. Call before acquire(). */
    configure(key: string, limit: number, windowMs: number): void {
        const existing = this.entries.get(key);
        if (existing) {
            existing.limit = limit;
            existing.windowMs = windowMs;
            return;
        }
        this.entries.set(key, {
            limit,
            windowMs,
            state: { current: 0, previous: 0, windowStart: now() },
        });
    }

    /** Try to acquire a slot. Returns whether the request is allowed. */
    acquire(key: string): AcquireResult {
        const entry = this.entries.get(key);
        if (!entry) {
            // No limit configured for this key — always allow.
            return { allowed: true };
        }
        ensureWindow(entry);
        const estimate = slidingEstimate(entry);
        if (estimate >= entry.limit) {
            const elapsed = now() - entry.state.windowStart;
            const retryAfterMs = Math.max(1, entry.windowMs - elapsed);
            return { allowed: false, retryAfterMs };
        }
        entry.state.current += 1;
        return { allowed: true };
    }

    /** Release a slot (e.g. after a failed call), correcting the counter. */
    release(key: string): void {
        const entry = this.entries.get(key);
        if (entry && entry.state.current > 0) {
            entry.state.current -= 1;
        }
    }

    /** Record token usage (for TPM tracking — call after the API response). */
    recordTokens(key: string, tokens: number): void {
        const entry = this.entries.get(key);
        if (!entry) {
            return;
        }
        ensureWindow(entry);
        entry.state.current += tokens;
    }

    /** Get a snapshot of the current state for a key. */
    getState(key: string): LimiterWindowState | null {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        ensureWindow(entry);
        const elapsed = now() - entry.state.windowStart;
        return {
            current: Math.round(slidingEstimate(entry)),
            limit: entry.limit,
            windowMs: entry.windowMs,
            resetAtMs: entry.state.windowStart + entry.windowMs,
        };
    }

    /** Reset one key or all keys. */
    reset(key?: string): void {
        if (key !== undefined) {
            const entry = this.entries.get(key);
            if (entry) {
                entry.state = { current: 0, previous: 0, windowStart: now() };
            }
            return;
        }
        for (const entry of this.entries.values()) {
            entry.state = { current: 0, previous: 0, windowStart: now() };
        }
    }

    /** List all configured keys. */
    keys(): string[] {
        return [...this.entries.keys()];
    }
}
