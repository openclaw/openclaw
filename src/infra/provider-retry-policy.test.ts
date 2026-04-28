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

  it("does not retry on 422 Unprocessable Entity", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(
      runner(async () => {
        attempts += 1;
        const error = new Error("Unprocessable Entity") as Error & { status: number };
        error.status = 422;
        throw error;
      }, "test"),
    ).rejects.toThrow("Unprocessable Entity");
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

describe("Retry-After header parsing", () => {
  // Helper to construct a thrown error shaped like the SDK errors the runner inspects.
  const errWithHeaders = (headers: Headers | Record<string, unknown>) =>
    Object.assign(new Error("429 Too Many Requests"), { status: 429, headers });

  it("honors Retry-After from a plain-object headers bag (lowercase key)", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw errWithHeaders({ "retry-after": "0" });
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("honors Retry-After from a plain-object headers bag (Title-Case key)", async () => {
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw errWithHeaders({ "Retry-After": "0" });
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("honors Retry-After from a fetch Headers instance", async () => {
    // Fetch's Headers class normalizes case internally and only exposes .get();
    // bracket access returns undefined. The previous bracket-only reader silently
    // dropped Retry-After here.
    let attempts = 0;
    const runner = createProviderApiRetryRunner({ retry: ZERO_DELAY_RETRY });
    const headers = new Headers();
    headers.set("Retry-After", "0");
    const result = await runner(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw errWithHeaders(headers);
      }
      return "ok";
    }, "test");
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});

describe("retry runner abort-signal awareness", () => {
  it("interrupts backoff sleep when the signal is aborted", async () => {
    // Use a long backoff so a non-abortable sleep would block far longer
    // than this test's wall-clock budget.
    const runner = createProviderApiRetryRunner({
      retry: { attempts: 5, minDelayMs: 5_000, maxDelayMs: 10_000, jitter: 0 },
    });
    const controller = new AbortController();
    let attempts = 0;
    const start = Date.now();
    const promise = runner(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          // Schedule the abort to fire while we're in the backoff sleep.
          setTimeout(() => controller.abort(), 50);
        }
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      },
      "test",
      { signal: controller.signal },
    );
    await expect(promise).rejects.toThrow("ECONNREFUSED");
    const elapsedMs = Date.now() - start;
    // First attempt fails immediately; backoff would normally be 5_000ms.
    // With the abort waking the sleep, total elapsed should be well under 1s.
    expect(elapsedMs).toBeLessThan(1_000);
    // Should have stopped after the first attempt (no second attempt issued
    // because we aborted during backoff before the next iteration).
    expect(attempts).toBe(1);
  });

  it("does not start a new attempt when signal is already aborted between attempts", async () => {
    const runner = createProviderApiRetryRunner({
      retry: { attempts: 5, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });
    const controller = new AbortController();
    let attempts = 0;
    const promise = runner(
      async () => {
        attempts += 1;
        controller.abort();
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      },
      "test",
      { signal: controller.signal },
    );
    await expect(promise).rejects.toThrow("ECONNREFUSED");
    // Even with attempts: 5, abort during the first attempt should prevent
    // any further attempts (we check signal.aborted at top of loop).
    expect(attempts).toBe(1);
  });
});
