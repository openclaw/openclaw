import { describe, expect, it } from "vitest";
import { classifyError, isRetryableError, retryAfterMs } from "./error-classifier.js";

describe("classifyError", () => {
  describe("HTTP status codes", () => {
    it("classifies 429 as rate_limit (retryable)", () => {
      const r = classifyError({ status: 429 });
      expect(r.category).toBe("rate_limit");
      expect(r.retryable).toBe(true);
      expect(r.cooldownMs).toBeGreaterThan(0);
    });

    it("classifies 401 as auth (not retryable)", () => {
      const r = classifyError({ status: 401 });
      expect(r.category).toBe("auth");
      expect(r.retryable).toBe(false);
    });

    it("classifies 403 as auth (not retryable)", () => {
      const r = classifyError({ status: 403 });
      expect(r.category).toBe("auth");
      expect(r.retryable).toBe(false);
    });

    it("classifies 402 as billing (not retryable)", () => {
      const r = classifyError({ status: 402 });
      expect(r.category).toBe("billing");
      expect(r.retryable).toBe(false);
    });

    it("classifies 400 as fatal (not retryable)", () => {
      const r = classifyError({ status: 400 });
      expect(r.category).toBe("fatal");
      expect(r.retryable).toBe(false);
    });

    it("classifies 404 as fatal (not retryable)", () => {
      const r = classifyError({ status: 404 });
      expect(r.category).toBe("fatal");
      expect(r.retryable).toBe(false);
    });

    it("classifies 500 as retryable", () => {
      const r = classifyError({ status: 500 });
      expect(r.category).toBe("retryable");
      expect(r.retryable).toBe(true);
    });

    it("classifies 502 as retryable", () => {
      const r = classifyError({ status: 502 });
      expect(r.retryable).toBe(true);
    });

    it("classifies 503 as retryable", () => {
      const r = classifyError({ status: 503 });
      expect(r.retryable).toBe(true);
    });

    it("classifies 501 as fatal (Not Implemented)", () => {
      const r = classifyError({ status: 501 });
      expect(r.category).toBe("fatal");
      expect(r.retryable).toBe(false);
    });

    it("reads nested response.status (Axios-style)", () => {
      const r = classifyError({ response: { status: 429 } });
      expect(r.category).toBe("rate_limit");
    });

    it("reads statusCode property", () => {
      const r = classifyError({ statusCode: 503 });
      expect(r.category).toBe("retryable");
    });
  });

  describe("network error codes", () => {
    it("classifies ECONNRESET as retryable", () => {
      const r = classifyError({ code: "ECONNRESET" });
      expect(r.category).toBe("retryable");
      expect(r.retryable).toBe(true);
    });

    it("classifies ETIMEDOUT as retryable", () => {
      const r = classifyError({ code: "ETIMEDOUT" });
      expect(r.retryable).toBe(true);
    });

    it("classifies ECONNREFUSED as retryable", () => {
      const r = classifyError({ code: "ECONNREFUSED" });
      expect(r.retryable).toBe(true);
    });

    it("classifies ENOTFOUND as fatal", () => {
      const r = classifyError({ code: "ENOTFOUND" });
      expect(r.category).toBe("fatal");
      expect(r.retryable).toBe(false);
    });

    it("classifies CERT_HAS_EXPIRED as fatal", () => {
      const r = classifyError({ code: "CERT_HAS_EXPIRED" });
      expect(r.category).toBe("fatal");
      expect(r.retryable).toBe(false);
    });
  });

  describe("message patterns", () => {
    it("detects OpenAI quota exceeded", () => {
      const r = classifyError({ message: "You exceeded your current quota" });
      expect(r.category).toBe("billing");
      expect(r.retryable).toBe(false);
    });

    it("detects rate limit message", () => {
      const r = classifyError({ message: "Rate limit reached for gpt-4" });
      expect(r.category).toBe("rate_limit");
      expect(r.retryable).toBe(true);
    });

    it("detects Anthropic overloaded", () => {
      const r = classifyError({ message: "overloaded_error" });
      expect(r.category).toBe("retryable");
    });

    it("detects timeout message", () => {
      const r = classifyError({ message: "Request timed out after 30000ms" });
      expect(r.category).toBe("retryable");
      expect(r.retryable).toBe(true);
    });

    it("detects socket hang up", () => {
      const r = classifyError({ message: "socket hang up" });
      expect(r.category).toBe("retryable");
    });
  });

  describe("edge cases", () => {
    it("handles null", () => {
      const r = classifyError(null);
      expect(r.category).toBe("unknown");
      expect(r.retryable).toBe(false);
    });

    it("handles undefined", () => {
      const r = classifyError(undefined);
      expect(r.category).toBe("unknown");
      expect(r.retryable).toBe(false);
    });

    it("handles string error", () => {
      const r = classifyError("something broke");
      expect(r.category).toBe("unknown");
      expect(r.retryable).toBe(true);
    });

    it("handles Error instance", () => {
      const r = classifyError(new Error("unexpected"));
      expect(r.category).toBe("unknown");
      expect(r.retryable).toBe(true);
    });

    it("unknown errors are retryable (cautious retry)", () => {
      const r = classifyError({ weird: true });
      expect(r.retryable).toBe(true);
      expect(r.cooldownMs).toBeGreaterThan(0);
    });

    it("HTTP status takes priority over message", () => {
      const r = classifyError({ status: 401, message: "Rate limit reached" });
      expect(r.category).toBe("auth");
    });
  });
});

describe("isRetryableError", () => {
  it("returns true for retryable errors", () => {
    expect(isRetryableError({ status: 502 })).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(isRetryableError({ status: 401 })).toBe(false);
  });

  it("returns false for billing errors", () => {
    expect(isRetryableError({ status: 402 })).toBe(false);
  });
});

describe("boundary status codes", () => {
  it("does not classify 399 as any HTTP category (below 4xx range)", () => {
    const r = classifyError({ status: 399 });
    expect(r.category).toBe("unknown");
  });

  it("classifies 499 as fatal (generic 4xx catch-all)", () => {
    const r = classifyError({ status: 499 });
    expect(r.category).toBe("fatal");
    expect(r.retryable).toBe(false);
  });

  it("classifies 501 as fatal before generic 5xx", () => {
    const r = classifyError({ status: 501 });
    expect(r.category).toBe("fatal");
    expect(r.reason).toContain("Not Implemented");
  });

  it("classifies 502 as retryable (generic 5xx)", () => {
    const r = classifyError({ status: 502 });
    expect(r.category).toBe("retryable");
    expect(r.retryable).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("returns cooldown for rate limit", () => {
    expect(retryAfterMs({ status: 429 })).toBe(60_000);
  });

  it("returns undefined for fatal errors", () => {
    expect(retryAfterMs({ status: 401 })).toBeUndefined();
  });
});
