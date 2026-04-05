import { describe, expect, it } from "vitest";
import { createProviderApiRetryRunner, PROVIDER_API_RETRY_DEFAULTS } from "./retry-policy.js";

const ZERO_DELAY_RETRY = {
  attempts: 3,
  minDelayMs: 0,
  maxDelayMs: 0,
  jitter: 0,
};

describe("createProviderApiRetryRunner", () => {
  it("retries on ECONNREFUSED", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("retries on 503 Service Unavailable", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("503 Service Unavailable");
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries on 429 rate limit", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("429 Too Many Requests");
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("retries on connection timeout", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("connect ETIMEDOUT");
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry on 401 Unauthorized", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(
      runner(async () => {
        attempts += 1;
        const error = new Error("Unauthorized") as Error & { status: number };
        error.status = 401;
        throw error;
      }, "test"),
    ).rejects.toThrow("Unauthorized");
    expect(attempts).toBe(1);
  });

  it("does not retry on 400 Bad Request", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(
      runner(async () => {
        attempts += 1;
        const error = new Error("Bad Request") as Error & { status: number };
        error.status = 400;
        throw error;
      }, "test"),
    ).rejects.toThrow("Bad Request");
    expect(attempts).toBe(1);
  });

  it("does not retry on 404 Not Found", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(
      runner(async () => {
        attempts += 1;
        const error = new Error("Not Found") as Error & { status: number };
        error.status = 404;
        throw error;
      }, "test"),
    ).rejects.toThrow("Not Found");
    expect(attempts).toBe(1);
  });

  it("respects attempt limit", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({
      retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
    });
    await expect(
      runner(async () => {
        attempts += 1;
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      }, "test"),
    ).rejects.toThrow("ECONNREFUSED");
    expect(attempts).toBe(2);
  });

  it("uses config overrides when provided", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({
      retry: { attempts: 5, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    await expect(
      runner(async () => {
        attempts += 1;
        throw new Error("503 temporarily unavailable");
      }, "test"),
    ).rejects.toThrow("temporarily unavailable");
    expect(attempts).toBe(5);
  });

  it("succeeds on first attempt without retry", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      return 42;
    }, "test");
    expect(result).toBe(42);
    expect(attempts).toBe(1);
  });

  it("exports sensible defaults", () => {
    expect(PROVIDER_API_RETRY_DEFAULTS.attempts).toBe(3);
    expect(PROVIDER_API_RETRY_DEFAULTS.minDelayMs).toBe(1_000);
    expect(PROVIDER_API_RETRY_DEFAULTS.maxDelayMs).toBe(30_000);
    expect(PROVIDER_API_RETRY_DEFAULTS.jitter).toBe(0.15);
  });
});
