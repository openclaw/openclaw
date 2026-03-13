import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock all provider fetch functions so loadProviderUsageSummary never hits the network.
vi.mock("./provider-usage.fetch.js", () => ({
  fetchClaudeUsage: vi.fn(),
  fetchCodexUsage: vi.fn(),
  fetchCopilotUsage: vi.fn(),
  fetchGeminiUsage: vi.fn(),
  fetchMinimaxUsage: vi.fn(),
  fetchZaiUsage: vi.fn(),
}));

vi.mock("./provider-usage.auth.js", () => ({
  resolveProviderAuths: vi.fn().mockResolvedValue([{ provider: "anthropic", token: "tok" }]),
}));

vi.mock("./fetch.js", () => ({
  resolveFetch: () => globalThis.fetch,
}));

import { fetchClaudeUsage } from "./provider-usage.fetch.js";
import { loadProviderUsageSummary, __test } from "./provider-usage.load.js";

const { usageCache, USAGE_CACHE_TTL_MS } = __test;

function resetCache() {
  usageCache.summary = undefined;
  usageCache.updatedAt = undefined;
  usageCache.inFlight = undefined;
}

describe("loadProviderUsageSummary caching", () => {
  beforeEach(() => {
    resetCache();
    vi.mocked(fetchClaudeUsage).mockReset();
  });

  it("caches results and does not re-fetch within TTL", async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [{ label: "daily", usedPercent: 42 }],
    });

    const first = await loadProviderUsageSummary();
    const second = await loadProviderUsageSummary();

    expect(first.providers).toHaveLength(1);
    expect(second).toBe(first);
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [{ label: "daily", usedPercent: 10 }],
    });

    await loadProviderUsageSummary();
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(1);

    // Expire the cache
    usageCache.updatedAt = Date.now() - USAGE_CACHE_TTL_MS - 1;

    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [{ label: "daily", usedPercent: 80 }],
    });

    // First call after expiry returns stale data while triggering background refresh
    const stale = await loadProviderUsageSummary();
    expect(stale.providers[0].windows[0].usedPercent).toBe(10);
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(2);

    // Wait a tick for the background refresh to land
    await vi.waitFor(() => {
      expect(usageCache.summary!.providers[0].windows[0].usedPercent).toBe(80);
    });

    // Next call within TTL returns the refreshed data
    const fresh = await loadProviderUsageSummary();
    expect(fresh.providers[0].windows[0].usedPercent).toBe(80);
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent requests", async () => {
    let resolveOnce: (v: unknown) => void;
    const slow = new Promise((r) => {
      resolveOnce = r;
    });

    vi.mocked(fetchClaudeUsage).mockImplementation(() =>
      slow.then(() => ({
        provider: "anthropic" as const,
        displayName: "Anthropic",
        windows: [{ label: "daily", usedPercent: 55 }],
      })),
    );

    const p1 = loadProviderUsageSummary();
    const p2 = loadProviderUsageSummary();

    resolveOnce!(undefined);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(fetchClaudeUsage).toHaveBeenCalledTimes(1);
  });

  it("returns stale data on fetch error when cache exists", async () => {
    vi.mocked(fetchClaudeUsage).mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [{ label: "daily", usedPercent: 25 }],
    });

    await loadProviderUsageSummary();

    // Expire cache, then fail
    usageCache.updatedAt = Date.now() - USAGE_CACHE_TTL_MS - 1;
    vi.mocked(fetchClaudeUsage).mockRejectedValue(new Error("429"));

    const fallback = await loadProviderUsageSummary();
    expect(fallback.providers[0].windows[0].usedPercent).toBe(25);
  });

  it("propagates error when no cached data exists", async () => {
    vi.mocked(fetchClaudeUsage).mockRejectedValue(new Error("429"));

    await expect(loadProviderUsageSummary()).rejects.toThrow("429");
  });
});
