import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
  recordSlackThreadParticipation,
} from "./sent-thread-cache.js";

describe("slack sent-thread-cache", () => {
  afterEach(() => {
    clearSlackThreadParticipationCache();
    vi.restoreAllMocks();
  });

  it("records and checks thread participation", () => {
    recordSlackThreadParticipation("C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("C123", "1700000000.000001")).toBe(true);
  });

  it("returns false for unrecorded threads", () => {
    expect(hasSlackThreadParticipation("C123", "1700000000.000001")).toBe(false);
  });

  it("distinguishes different channels and threads", () => {
    recordSlackThreadParticipation("C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("C123", "1700000000.000002")).toBe(false);
    expect(hasSlackThreadParticipation("C456", "1700000000.000001")).toBe(false);
  });

  it("ignores empty channelId or threadTs", () => {
    recordSlackThreadParticipation("", "1700000000.000001");
    recordSlackThreadParticipation("C123", "");
    expect(hasSlackThreadParticipation("", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("C123", "")).toBe(false);
  });

  it("clears all entries", () => {
    recordSlackThreadParticipation("C123", "1700000000.000001");
    recordSlackThreadParticipation("C456", "1700000000.000002");
    clearSlackThreadParticipationCache();
    expect(hasSlackThreadParticipation("C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("C456", "1700000000.000002")).toBe(false);
  });

  it("expired entries return false and are cleaned up on read", () => {
    recordSlackThreadParticipation("C123", "1700000000.000001");
    // Advance time past the 24-hour TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(hasSlackThreadParticipation("C123", "1700000000.000001")).toBe(false);
  });
});
