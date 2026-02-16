import { describe, expect, it, vi } from "vitest";
import { classifyLiveError, describeLive, withLiveRetry } from "./live-test-helpers.js";

// ---------------------------------------------------------------------------
// classifyLiveError
// ---------------------------------------------------------------------------

describe("classifyLiveError", () => {
  it("classifies 401 as auth", () => {
    const result = classifyLiveError(new Error("HTTP 401 Unauthorized"));
    expect(result.type).toBe("auth");
  });

  it("classifies 403 as auth", () => {
    const result = classifyLiveError(new Error("HTTP 403 Forbidden"));
    expect(result.type).toBe("auth");
  });

  it("classifies invalid key as auth", () => {
    const result = classifyLiveError(new Error("invalid API key provided"));
    expect(result.type).toBe("auth");
  });

  it("classifies billing error as auth", () => {
    const result = classifyLiveError(new Error("Your billing account is inactive"));
    expect(result.type).toBe("auth");
  });

  it("classifies 429 as rate-limit", () => {
    const result = classifyLiveError(new Error("HTTP 429 Too Many Requests"));
    expect(result.type).toBe("rate-limit");
  });

  it("classifies rate limit text as rate-limit", () => {
    const result = classifyLiveError(new Error("rate limit exceeded"));
    expect(result.type).toBe("rate-limit");
  });

  it("classifies quota as rate-limit", () => {
    const result = classifyLiveError(new Error("Quota exceeded for model"));
    expect(result.type).toBe("rate-limit");
  });

  it("classifies 503 as unavailable", () => {
    const result = classifyLiveError(new Error("HTTP 503 Service Unavailable"));
    expect(result.type).toBe("unavailable");
  });

  it("classifies 502 as unavailable", () => {
    const result = classifyLiveError(new Error("HTTP 502 Bad Gateway"));
    expect(result.type).toBe("unavailable");
  });

  it("classifies ECONNREFUSED as unavailable", () => {
    const result = classifyLiveError(new Error("connect ECONNREFUSED 127.0.0.1:8080"));
    expect(result.type).toBe("unavailable");
  });

  it("classifies ETIMEDOUT as unavailable", () => {
    const result = classifyLiveError(new Error("connect ETIMEDOUT 10.0.0.1:443"));
    expect(result.type).toBe("unavailable");
  });

  it("classifies ECONNRESET as network", () => {
    const result = classifyLiveError(new Error("read ECONNRESET"));
    expect(result.type).toBe("network");
  });

  it("classifies fetch failed as network", () => {
    const result = classifyLiveError(new Error("fetch failed"));
    expect(result.type).toBe("network");
  });

  it("classifies unknown errors as logic", () => {
    const result = classifyLiveError(new Error("expected 3 to be 5"));
    expect(result.type).toBe("logic");
  });

  it("strips stack traces from messages", () => {
    const err = new Error("something failed");
    err.stack =
      "Error: something failed\n    at Object.<anonymous> (foo.ts:1:1)\n    at Module._compile";
    const result = classifyLiveError(err);
    expect(result.message).toBe("Error: something failed");
    expect(result.message).not.toContain("at Object");
  });

  it("handles non-Error values", () => {
    const result = classifyLiveError("string error");
    expect(result.type).toBe("logic");
    expect(result.message).toBe("string error");
  });
});

// ---------------------------------------------------------------------------
// withLiveRetry
// ---------------------------------------------------------------------------

describe("withLiveRetry", () => {
  it("returns on success", async () => {
    const result = await withLiveRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("retries on rate-limit errors up to max", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 2) {
        throw new Error("HTTP 429 Too Many Requests");
      }
      return "ok";
    };
    const result = await withLiveRetry(fn, { retries: 2, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries on rate-limit", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("HTTP 429 Too Many Requests");
    };
    await expect(withLiveRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("429");
    expect(calls).toBe(3);
  });

  it("does NOT retry on auth errors", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("HTTP 401 Unauthorized");
    };
    await expect(withLiveRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("401");
    expect(calls).toBe(1);
  });

  it("does NOT retry on unavailable errors", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("HTTP 503 Service Unavailable");
    };
    await expect(withLiveRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("503");
    expect(calls).toBe(1);
  });

  it("does NOT retry on logic errors", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("expected 3 to be 5");
    };
    await expect(withLiveRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow("expected 3");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// describeLive
// ---------------------------------------------------------------------------

describe("describeLive", () => {
  it("returns describe.skip when LIVE flags are not set", () => {
    const original = { LIVE: process.env.LIVE, OPENCLAW_LIVE_TEST: process.env.OPENCLAW_LIVE_TEST };
    delete process.env.LIVE;
    delete process.env.OPENCLAW_LIVE_TEST;

    const result = describeLive({
      name: "test suite",
      envVars: [{ name: "SOME_KEY", value: "key123", required: true }],
    });

    // Restore
    process.env.LIVE = original.LIVE;
    process.env.OPENCLAW_LIVE_TEST = original.OPENCLAW_LIVE_TEST;

    // describe.skip is a function with different identity than describe
    expect(result).not.toBe(describe);
  });

  it("returns describe.skip when required key is missing", () => {
    const original = { LIVE: process.env.LIVE };
    process.env.LIVE = "1";

    const result = describeLive({
      name: "test suite",
      envVars: [{ name: "MISSING_KEY", value: undefined, required: true }],
    });

    process.env.LIVE = original.LIVE;
    expect(result).not.toBe(describe);
  });

  it("logs yellow skip message when keys are missing", () => {
    const original = { LIVE: process.env.LIVE };
    process.env.LIVE = "1";

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    describeLive({
      name: "my suite",
      envVars: [{ name: "MY_API_KEY", value: "", required: true }],
    });

    process.env.LIVE = original.LIVE;

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[live-skip] my suite: missing MY_API_KEY"),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("\x1b[33m"));
    spy.mockRestore();
  });

  it("accepts provider-specific live flags", () => {
    const original = { LIVE: process.env.LIVE, OPENCLAW_LIVE_TEST: process.env.OPENCLAW_LIVE_TEST };
    delete process.env.LIVE;
    delete process.env.OPENCLAW_LIVE_TEST;

    const result = describeLive({
      name: "provider suite",
      envVars: [
        { name: "MINIMAX_LIVE_TEST", value: "1", required: false },
        { name: "MINIMAX_API_KEY", value: "key123", required: true },
      ],
    });

    process.env.LIVE = original.LIVE;
    process.env.OPENCLAW_LIVE_TEST = original.OPENCLAW_LIVE_TEST;

    // With provider-specific flag set, should return describe (not skip)
    expect(result).toBe(describe);
  });
});
