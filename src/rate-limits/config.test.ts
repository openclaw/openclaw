import { describe, expect, it } from "vitest";
import { resolveRateLimitsConfig } from "./config.js";

describe("resolveRateLimitsConfig", () => {
    it("returns defaults when no config provided", () => {
        const config = resolveRateLimitsConfig(undefined);
        expect(config.enabled).toBe(true);
        expect(config.defaults.rpm).toBe(60);
        expect(config.defaults.tpm).toBe(100_000);
        expect(config.defaults.rpd).toBe(0);
        expect(config.defaults.dailyTokenBudget).toBe(0);
        expect(config.defaults.monthlyTokenBudget).toBe(0);
        expect(config.queue.maxSize).toBe(100);
        expect(config.queue.timeoutMs).toBe(30_000);
        expect(config.budgets.warningThresholds).toEqual([0.8, 0.9, 1.0]);
        expect(config.budgets.hardBlock).toBe(false);
        expect(config.retry.attempts).toBe(3);
        expect(config.retry.minDelayMs).toBe(500);
        expect(config.retry.maxDelayMs).toBe(60_000);
        expect(config.retry.jitter).toBe(0.15);
    });

    it("disables rate limiting when enabled is false", () => {
        const config = resolveRateLimitsConfig({ enabled: false });
        expect(config.enabled).toBe(false);
    });

    it("merges provider-specific overrides with defaults", () => {
        const config = resolveRateLimitsConfig({
            defaults: { rpm: 30 },
            providers: {
                openai: { rpm: 120, tpm: 200_000 },
            },
        });

        expect(config.defaults.rpm).toBe(30);
        expect(config.defaults.tpm).toBe(100_000); // inherits default
        expect(config.providers.openai?.rpm).toBe(120);
        expect(config.providers.openai?.tpm).toBe(200_000);
    });

    it("overrides queue settings", () => {
        const config = resolveRateLimitsConfig({
            queue: { maxSize: 200, timeoutMs: 60_000 },
        });

        expect(config.queue.maxSize).toBe(200);
        expect(config.queue.timeoutMs).toBe(60_000);
    });

    it("configures budget warning thresholds and hard block", () => {
        const config = resolveRateLimitsConfig({
            budgets: { warningThresholds: [0.9], hardBlock: true },
        });

        expect(config.budgets.warningThresholds).toEqual([0.9]);
        expect(config.budgets.hardBlock).toBe(true);
    });

    it("configures retry settings", () => {
        const config = resolveRateLimitsConfig({
            retry: { attempts: 5, minDelayMs: 1000 },
        });

        expect(config.retry.attempts).toBe(5);
        expect(config.retry.minDelayMs).toBe(1000);
        expect(config.retry.maxDelayMs).toBe(60_000); // inherits default
    });

    it("ignores zero and negative values for positive-only fields", () => {
        const config = resolveRateLimitsConfig({
            defaults: { rpm: 0, tpm: -1 },
            queue: { maxSize: 0, timeoutMs: -100 },
        });

        // Should fall back to defaults since 0 and negatives aren't valid
        expect(config.defaults.rpm).toBe(60);
        expect(config.defaults.tpm).toBe(100_000);
        expect(config.queue.maxSize).toBe(100);
        expect(config.queue.timeoutMs).toBe(30_000);
    });

    it("skips undefined provider entries", () => {
        const config = resolveRateLimitsConfig({
            providers: {
                openai: { rpm: 120 },
                anthropic: undefined,
            },
        });

        expect(Object.keys(config.providers)).toEqual(["openai"]);
    });
});
