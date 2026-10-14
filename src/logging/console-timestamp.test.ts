import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatConsoleTimestamp } from "./console.js";

describe("formatConsoleTimestamp", () => {
  beforeEach(() => {
    vi.stubEnv("TZ", "America/New_York");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("pretty style returns local HH:MM:SS without timezone suffix", () => {
    expect(formatConsoleTimestamp("pretty")).toBe("13:01:02");
  });

  it("compact style returns local ISO-like timestamp with timezone offset", () => {
    expect(formatConsoleTimestamp("compact")).toBe("2026-01-17T13:01:02.345-05:00");
  });
});
