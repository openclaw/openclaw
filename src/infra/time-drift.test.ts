import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkTimeDrift, formatDriftForLog, type TimeDriftCheckResult } from "./time-drift.js";

describe("checkTimeDrift", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports low drift when clocks agree", async () => {
    const serverDate = new Date(1_700_000_000_000).toUTCString();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { date: serverDate } }));

    const result = await checkTimeDrift({ thresholdSeconds: 60 });
    expect(result.absDriftMs).toBeLessThan(1_000);
    expect(result.exceeds).toBe(false);
    expect(result.source).toBe("https://www.google.com");
  });

  it("detects drift when local clock is ahead", async () => {
    // Server says it's 120 seconds behind local.
    const serverDate = new Date(1_700_000_000_000 - 120_000).toUTCString();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { date: serverDate } }));

    const result = await checkTimeDrift({ thresholdSeconds: 60 });
    expect(result.driftMs).toBeGreaterThanOrEqual(119_000);
    expect(result.exceeds).toBe(true);
  });

  it("detects drift when local clock is behind", async () => {
    const serverDate = new Date(1_700_000_000_000 + 90_000).toUTCString();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { date: serverDate } }));

    const result = await checkTimeDrift({ thresholdSeconds: 60 });
    expect(result.driftMs).toBeLessThan(0);
    expect(result.exceeds).toBe(true);
  });

  it("throws when Date header is missing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null));

    await expect(checkTimeDrift()).rejects.toThrow("no Date header");
  });

  it("throws when Date header is unparseable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { date: "not-a-date" } }));

    await expect(checkTimeDrift()).rejects.toThrow("unparseable Date header");
  });

  it("uses custom source URL", async () => {
    const serverDate = new Date(1_700_000_000_000).toUTCString();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { headers: { date: serverDate } }));

    const result = await checkTimeDrift({ source: "https://example.com" });
    expect(result.source).toBe("https://example.com");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("propagates fetch errors (e.g. timeout)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));

    await expect(checkTimeDrift()).rejects.toThrow("timeout");
  });
});

describe("formatDriftForLog", () => {
  it("formats within-tolerance result", () => {
    const result: TimeDriftCheckResult = {
      driftMs: 500,
      absDriftMs: 500,
      exceeds: false,
      source: "https://www.google.com",
      thresholdMs: 60_000,
    };
    const msg = formatDriftForLog(result);
    expect(msg).toContain("within tolerance");
    expect(msg).toContain("0.5s ahead");
  });

  it("formats exceeding result", () => {
    const result: TimeDriftCheckResult = {
      driftMs: -120_000,
      absDriftMs: 120_000,
      exceeds: true,
      source: "https://www.google.com",
      thresholdMs: 60_000,
    };
    const msg = formatDriftForLog(result);
    expect(msg).toContain("clock is");
    expect(msg).toContain("behind");
  });
});
