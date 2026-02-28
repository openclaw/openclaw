import { describe, expect, it } from "vitest";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  classifyRunErrorKind,
  errorBackoffMs,
  resolveBackoffSchedule,
} from "./retry-policy.js";

describe("resolveBackoffSchedule", () => {
  it("returns default schedule when no config is provided", () => {
    expect(resolveBackoffSchedule(undefined)).toBe(DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  });

  it("returns default schedule when config has no retryBackoff", () => {
    expect(resolveBackoffSchedule({ enabled: true })).toBe(DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  });

  it("returns default schedule when retryBackoff is empty", () => {
    expect(resolveBackoffSchedule({ retryBackoff: [] })).toBe(DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  });

  it("returns custom schedule when retryBackoff has valid entries", () => {
    const custom = [5_000, 10_000, 30_000];
    expect(resolveBackoffSchedule({ retryBackoff: custom })).toEqual(custom);
  });

  it("filters out invalid entries from retryBackoff", () => {
    const custom = [5_000, -1, 0, NaN, 10_000, Infinity];
    expect(resolveBackoffSchedule({ retryBackoff: custom })).toEqual([5_000, 10_000]);
  });

  it("returns default when all entries are invalid", () => {
    expect(resolveBackoffSchedule({ retryBackoff: [-1, 0, NaN] })).toBe(
      DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
    );
  });
});

describe("errorBackoffMs", () => {
  it("returns the first entry for 1 consecutive error", () => {
    expect(errorBackoffMs(1)).toBe(30_000);
  });

  it("returns the second entry for 2 consecutive errors", () => {
    expect(errorBackoffMs(2)).toBe(60_000);
  });

  it("clamps to the last entry for high error counts", () => {
    expect(errorBackoffMs(100)).toBe(60 * 60_000);
  });

  it("uses custom schedule when provided", () => {
    const schedule = [1_000, 5_000];
    expect(errorBackoffMs(1, schedule)).toBe(1_000);
    expect(errorBackoffMs(2, schedule)).toBe(5_000);
    expect(errorBackoffMs(10, schedule)).toBe(5_000);
  });

  it("handles zero/negative consecutiveErrors gracefully", () => {
    expect(errorBackoffMs(0)).toBe(30_000);
    expect(errorBackoffMs(-1)).toBe(30_000);
  });
});

describe("classifyRunErrorKind", () => {
  it("returns transient for empty/undefined error", () => {
    expect(classifyRunErrorKind(undefined)).toBe("transient");
    expect(classifyRunErrorKind("")).toBe("transient");
  });

  it("classifies timeout errors as transient", () => {
    expect(classifyRunErrorKind("cron: job execution timed out")).toBe("transient");
    expect(classifyRunErrorKind("Request timeout after 30s")).toBe("transient");
  });

  it("classifies connection errors as transient", () => {
    expect(classifyRunErrorKind("connect ECONNREFUSED 127.0.0.1:443")).toBe("transient");
    expect(classifyRunErrorKind("socket hang up")).toBe("transient");
    expect(classifyRunErrorKind("ECONNRESET")).toBe("transient");
    expect(classifyRunErrorKind("ETIMEDOUT")).toBe("transient");
    expect(classifyRunErrorKind("ENOTFOUND api.example.com")).toBe("transient");
  });

  it("classifies rate limit errors as transient", () => {
    expect(classifyRunErrorKind("Rate limit exceeded")).toBe("transient");
    expect(classifyRunErrorKind("HTTP 429 Too Many Requests")).toBe("transient");
  });

  it("classifies server errors as transient", () => {
    expect(classifyRunErrorKind("HTTP 502 Bad Gateway")).toBe("transient");
    expect(classifyRunErrorKind("HTTP 503 Service Unavailable")).toBe("transient");
  });

  it("classifies network errors as transient", () => {
    expect(classifyRunErrorKind("network error")).toBe("transient");
    expect(classifyRunErrorKind("fetch failed")).toBe("transient");
  });

  it("classifies permission/auth errors as terminal", () => {
    expect(classifyRunErrorKind("HTTP 401 Unauthorized")).toBe("terminal");
    expect(classifyRunErrorKind("HTTP 403 Forbidden")).toBe("terminal");
    expect(classifyRunErrorKind("model not allowed: gpt-5")).toBe("terminal");
  });

  it("classifies config errors as terminal", () => {
    expect(classifyRunErrorKind("invalid model config")).toBe("terminal");
    expect(classifyRunErrorKind("missing permission for agent")).toBe("terminal");
    expect(classifyRunErrorKind('payload requires "message" field')).toBe("terminal");
  });

  it("classifies not-found model errors as terminal", () => {
    expect(classifyRunErrorKind("not found model gpt-5 in catalog")).toBe("terminal");
  });

  it("defaults to transient for unknown errors", () => {
    expect(classifyRunErrorKind("something unexpected happened")).toBe("transient");
    expect(classifyRunErrorKind("OpenAI API error: internal server error")).toBe("transient");
  });
});
