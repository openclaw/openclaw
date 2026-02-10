import { describe, expect, it, beforeEach } from "vitest";
import { SlidingWindowLimiter } from "./limiter.js";

const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 86_400_000;

describe("SlidingWindowLimiter", () => {
    let limiter: SlidingWindowLimiter;

    beforeEach(() => {
        limiter = new SlidingWindowLimiter();
        limiter.configure("test:rpm", 10, ONE_MINUTE_MS);
        limiter.configure("test:tpm", 1000, ONE_MINUTE_MS);
        limiter.configure("test:rpd", 100, ONE_DAY_MS);
    });

    describe("acquire", () => {
        it("allows requests within the RPM limit", () => {
            for (let i = 0; i < 10; i++) {
                const result = limiter.acquire("test:rpm");
                expect(result.allowed).toBe(true);
            }
        });

        it("rejects requests exceeding RPM limit", () => {
            for (let i = 0; i < 10; i++) {
                limiter.acquire("test:rpm");
            }
            const result = limiter.acquire("test:rpm");
            expect(result.allowed).toBe(false);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it("rejects when RPD limit is exceeded", () => {
            const small = new SlidingWindowLimiter();
            small.configure("small:rpd", 3, ONE_DAY_MS);
            for (let i = 0; i < 3; i++) {
                expect(small.acquire("small:rpd").allowed).toBe(true);
            }
            const result = small.acquire("small:rpd");
            expect(result.allowed).toBe(false);
        });

        it("always allows for unconfigured keys", () => {
            // No key "unknown:rpm" configured — should default to allow.
            for (let i = 0; i < 100; i++) {
                expect(limiter.acquire("unknown:rpm").allowed).toBe(true);
            }
        });
    });

    describe("recordTokens", () => {
        it("tracks token usage and blocks when TPM exceeded", () => {
            const result1 = limiter.acquire("test:rpm");
            expect(result1.allowed).toBe(true);
            limiter.recordTokens("test:tpm", 1000);

            // TPM at limit — next acquire on tpm key should fail.
            const result2 = limiter.acquire("test:tpm");
            expect(result2.allowed).toBe(false);
            expect(result2.retryAfterMs).toBeGreaterThan(0);
        });

        it("allows requests when tokens are under limit", () => {
            limiter.recordTokens("test:tpm", 500);

            const result = limiter.acquire("test:tpm");
            expect(result.allowed).toBe(true);
        });
    });

    describe("getState", () => {
        it("returns current state for a configured key", () => {
            limiter.acquire("test:rpm");
            const state = limiter.getState("test:rpm");
            expect(state).not.toBeNull();
            expect(state!.current).toBe(1);
            expect(state!.limit).toBe(10);
            expect(state!.windowMs).toBe(ONE_MINUTE_MS);
        });

        it("returns null for unconfigured keys", () => {
            const state = limiter.getState("unknown:rpm");
            expect(state).toBeNull();
        });
    });

    describe("reset", () => {
        it("clears counters for a specific key", () => {
            for (let i = 0; i < 10; i++) {
                limiter.acquire("test:rpm");
            }
            expect(limiter.acquire("test:rpm").allowed).toBe(false);

            limiter.reset("test:rpm");

            expect(limiter.acquire("test:rpm").allowed).toBe(true);
        });

        it("clears all counters when called without key", () => {
            for (let i = 0; i < 10; i++) {
                limiter.acquire("test:rpm");
            }
            limiter.recordTokens("test:tpm", 1000);
            expect(limiter.acquire("test:rpm").allowed).toBe(false);
            expect(limiter.acquire("test:tpm").allowed).toBe(false);

            limiter.reset();

            expect(limiter.acquire("test:rpm").allowed).toBe(true);
            expect(limiter.acquire("test:tpm").allowed).toBe(true);
        });
    });

    describe("release", () => {
        it("decrements the current count", () => {
            limiter.acquire("test:rpm");
            let state = limiter.getState("test:rpm");
            expect(state?.current).toBe(1);

            limiter.release("test:rpm");
            state = limiter.getState("test:rpm");
            expect(state?.current).toBe(0);
        });

        it("does not decrement below zero", () => {
            limiter.release("test:rpm");
            const state = limiter.getState("test:rpm");
            expect(state?.current).toBe(0);
        });

        it("allows a request after release when limit was reached", () => {
            // Fill the limit (10)
            for (let i = 0; i < 10; i++) {
                limiter.acquire("test:rpm");
            }
            // Next one fails
            expect(limiter.acquire("test:rpm").allowed).toBe(false);

            // Release one
            limiter.release("test:rpm");

            // Next one succeeds
            expect(limiter.acquire("test:rpm").allowed).toBe(true);
        });
    });

    describe("keys", () => {
        it("lists all configured keys", () => {
            const keys = limiter.keys();
            expect(keys).toContain("test:rpm");
            expect(keys).toContain("test:tpm");
            expect(keys).toContain("test:rpd");
        });
    });
});
