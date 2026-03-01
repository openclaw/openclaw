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
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("returns false for unrecorded threads", () => {
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("distinguishes different channels and threads", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000002")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000001")).toBe(false);
  });

  it("scopes participation by accountId", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A2", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("ignores empty accountId, channelId, or threadTs", () => {
    recordSlackThreadParticipation("", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C123", "");
    expect(hasSlackThreadParticipation("", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "")).toBe(false);
  });

  it("clears all entries", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C456", "1700000000.000002");
    clearSlackThreadParticipationCache();
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000002")).toBe(false);
  });

  it("expired entries return false and are cleaned up on read", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    // Advance time past the 24-hour TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });
});
