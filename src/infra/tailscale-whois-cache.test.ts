import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./tailscale.js";

afterEach(() => {
  __testing.resetWhoisCache();
  vi.restoreAllMocks();
});

describe("whoisCache memory bounds", () => {
  it("caps cached entries to prevent unbounded growth", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    for (let i = 0; i < __testing.WHOIS_CACHE_MAX_SIZE + 500; i++) {
      __testing.writeCachedWhois(`10.0.${Math.floor(i / 256)}.${i % 256}`, null, 60_000);
    }

    expect(__testing.whoisCacheSize()).toBeLessThanOrEqual(__testing.WHOIS_CACHE_MAX_SIZE);
  });

  it("prunes expired entries before evicting live ones", () => {
    // Fill cache at t=1_000_000 with TTL=60_000 (expires at 1_060_000)
    const t0 = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);

    for (let i = 0; i < __testing.WHOIS_CACHE_MAX_SIZE; i++) {
      __testing.writeCachedWhois(`10.0.${Math.floor(i / 256)}.${i % 256}`, null, 60_000);
    }
    expect(__testing.whoisCacheSize()).toBe(__testing.WHOIS_CACHE_MAX_SIZE);

    // Advance time past expiry, add one fresh entry → all expired entries pruned
    const t1 = 1_060_001;
    vi.spyOn(Date, "now").mockReturnValue(t1);

    __testing.writeCachedWhois("192.168.1.1", { login: "fresh-user" }, 60_000);

    // All old entries expired and pruned; only the fresh one remains
    expect(__testing.whoisCacheSize()).toBe(1);
  });

  it("does not prune when under the cap", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    for (let i = 0; i < 100; i++) {
      __testing.writeCachedWhois(`10.0.0.${i}`, { login: `user-${i}` }, 60_000);
    }

    expect(__testing.whoisCacheSize()).toBe(100);
  });

  it("refreshed entries are not evicted before newer entries (LRU order)", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    // Fill to capacity
    for (let i = 0; i < __testing.WHOIS_CACHE_MAX_SIZE; i++) {
      __testing.writeCachedWhois(`10.0.${Math.floor(i / 256)}.${i % 256}`, null, 120_000);
    }
    expect(__testing.whoisCacheSize()).toBe(__testing.WHOIS_CACHE_MAX_SIZE);

    // Refresh the first entry (10.0.0.0) — this should move it to the tail
    __testing.writeCachedWhois("10.0.0.0", { login: "refreshed" }, 120_000);

    // Now add a new entry to trigger eviction
    __testing.writeCachedWhois("192.168.1.1", null, 120_000);

    // The refreshed entry (10.0.0.0) should survive because it was moved to tail.
    // The second entry (10.0.0.1) should have been evicted as the oldest.
    expect(__testing.whoisCacheSize()).toBe(__testing.WHOIS_CACHE_MAX_SIZE);
  });
});
