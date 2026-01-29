// src/cli/gateway-cli/crash-tracker.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordCrash,
  getRecentCrashes,
  getCrashesInLastHour,
  clearCrashes,
  classifyError,
} from "./crash-tracker.js";

describe("crash-tracker", () => {
  beforeEach(() => {
    clearCrashes();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a crash with timestamp", () => {
    vi.setSystemTime(new Date("2026-01-29T12:00:00Z"));
    recordCrash({
      errorType: "fetch_failed",
      errorMessage: "ECONNREFUSED",
      uptimeMs: 5000,
      backoffMs: 2000,
      consecutiveFailures: 1,
    });

    const crashes = getRecentCrashes();
    expect(crashes).toHaveLength(1);
    expect(crashes[0].timestamp).toBe(Date.now());
    expect(crashes[0].errorType).toBe("fetch_failed");
  });

  it("limits to MAX_CRASH_HISTORY entries", () => {
    for (let i = 0; i < 25; i++) {
      recordCrash({
        errorType: "network_error",
        errorMessage: `Error ${i}`,
        uptimeMs: 0,
        backoffMs: 2000,
        consecutiveFailures: i + 1,
      });
    }

    const crashes = getRecentCrashes();
    expect(crashes).toHaveLength(20);
    expect(crashes[0].errorMessage).toBe("Error 5"); // First 5 were dropped
  });

  it("counts crashes in last hour correctly", () => {
    vi.setSystemTime(new Date("2026-01-29T12:00:00Z"));
    recordCrash({
      errorType: "fetch_failed",
      errorMessage: "a",
      uptimeMs: 0,
      backoffMs: 2000,
      consecutiveFailures: 1,
    });

    vi.setSystemTime(new Date("2026-01-29T12:30:00Z"));
    recordCrash({
      errorType: "fetch_failed",
      errorMessage: "b",
      uptimeMs: 0,
      backoffMs: 4000,
      consecutiveFailures: 2,
    });

    // At 13:29:59, "a" is 89 min old (outside), "b" is 59 min old (inside)
    vi.setSystemTime(new Date("2026-01-29T13:29:59Z"));
    expect(getCrashesInLastHour()).toBe(1); // Only "b" is within last hour
  });
});

describe("classifyError", () => {
  it("classifies fetch failed errors", () => {
    expect(classifyError(new Error("TypeError: fetch failed"))).toBe("fetch_failed");
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("fetch_failed");
  });

  it("classifies network errors", () => {
    expect(classifyError(new Error("read ECONNRESET"))).toBe("network_error");
    expect(classifyError(new Error("connect ETIMEDOUT"))).toBe("network_error");
    expect(classifyError(new Error("network unreachable"))).toBe("network_error");
  });

  it("classifies startup errors", () => {
    expect(classifyError(new Error("startup failed: missing config"))).toBe("startup_error");
    expect(classifyError(new Error("init error: bad credentials"))).toBe("startup_error");
  });

  it("defaults to runtime_error for unrecognized errors", () => {
    expect(classifyError(new Error("something went wrong"))).toBe("runtime_error");
    expect(classifyError(new Error("unexpected condition"))).toBe("runtime_error");
  });

  it("handles null/undefined safely", () => {
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });

  it("handles non-Error objects", () => {
    expect(classifyError("string error")).toBe("runtime_error");
    expect(classifyError({ message: "object error" })).toBe("runtime_error");
  });
});
