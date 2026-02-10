import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CallResult, RateLimitScope } from "./types.js";
import { resolveRateLimitsConfig } from "./config.js";
import { RateLimitedRunner } from "./provider-wrapper.js";

const TEST_STATE_DIR = path.join(process.cwd(), ".test-state-wrapper");

describe("RateLimitedRunner - Retries & Usage", () => {
  let runner: RateLimitedRunner;
  const scope: RateLimitScope = { provider: "test", model: "model-a" };

  beforeEach(() => {
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runner.flush?.();
    vi.clearAllTimers();
    try {
      if (fs.existsSync(TEST_STATE_DIR)) {
        fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors (e.g. file locks)
    }
  });
  beforeEach(() => {
    const config = resolveRateLimitsConfig({
      enabled: true,
      retry: { attempts: 3, minDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      providers: {
        test: { tpm: 1000, rpm: 100 },
      },
    });
    runner = new RateLimitedRunner({ config, stateDir: TEST_STATE_DIR });
  });

  it("accumulates tokens from failed attempts", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("Rate limit 429");
        Object.assign(err, {
          status: 429, // Trigger retry
          usage: { input: 10, output: 5 }, // 15 tokens per failure
        });
        throw err;
      }
      return {
        result: "success",
        usage: { input: 20, output: 20 }, // 40 tokens on success
      } as CallResult<{ result: string }>;
    });

    // 2 failures (15 * 2 = 30) + 1 success (40) = 70 total tokens
    await runner.withRateLimit(scope, fn);

    // Verify budget has recorded 70 tokens
    const status = runner.budget.getStatus(scope);
    // dailyUsedTokens should be 70
    expect(status.dailyUsedTokens).toBe(70);
  });

  it("only records success tokens if failures have no usage", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("Rate limit 429");
        Object.assign(err, { status: 429 });
        // No usage on error
        throw err;
      }
      return {
        result: "success",
        usage: { input: 10, output: 10 }, // 20 tokens
      } as CallResult<{ result: string }>;
    });

    await runner.withRateLimit(scope, fn);

    const status = runner.budget.getStatus(scope);
    expect(status.dailyUsedTokens).toBe(20);
  });
});
