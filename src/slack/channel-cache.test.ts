import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  SlackChannelCache,
  getDefaultChannelCache,
  resetDefaultChannelCache,
} from "./channel-cache.js";

describe("SlackChannelCache", () => {
  let cache: SlackChannelCache;

  beforeEach(() => {
    cache = new SlackChannelCache({ ttlMs: 1000 });
  });

  it("stores and retrieves by ID", () => {
    cache.set({ id: "C123", name: "general", archived: false, isPrivate: false });
    const entry = cache.getById("C123");
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("general");
    expect(entry?.id).toBe("C123");
  });

  it("stores and retrieves by name (case-insensitive)", () => {
    cache.set({ id: "C123", name: "General", archived: false, isPrivate: false });
    const entry = cache.getByName("general");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("C123");

    const entry2 = cache.getByName("GENERAL");
    expect(entry2?.id).toBe("C123");
  });

  it("returns undefined for unknown channels", () => {
    expect(cache.getById("C999")).toBeUndefined();
    expect(cache.getByName("nonexistent")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    try {
      cache.set({ id: "C123", name: "general", archived: false, isPrivate: false });
      expect(cache.getById("C123")).toBeDefined();

      vi.advanceTimersByTime(1001);
      expect(cache.getById("C123")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates by ID", () => {
    cache.set({ id: "C123", name: "general", archived: false, isPrivate: false });
    cache.invalidate("C123");
    expect(cache.getById("C123")).toBeUndefined();
    expect(cache.getByName("general")).toBeUndefined();
  });

  it("invalidates by name", () => {
    cache.set({ id: "C123", name: "general", archived: false, isPrivate: false });
    cache.invalidate("general");
    expect(cache.getById("C123")).toBeUndefined();
    expect(cache.getByName("general")).toBeUndefined();
  });

  it("bulk loads with setMany", () => {
    cache.setMany([
      { id: "C1", name: "alpha", archived: false, isPrivate: false },
      { id: "C2", name: "beta", archived: true, isPrivate: false },
    ]);
    expect(cache.size).toBe(2);
    expect(cache.getByName("alpha")?.id).toBe("C1");
    expect(cache.getByName("beta")?.archived).toBe(true);
  });

  it("evicts oldest when at capacity", () => {
    const small = new SlackChannelCache({ ttlMs: 60000, maxEntries: 2 });
    small.set({ id: "C1", name: "first", archived: false, isPrivate: false });
    small.set({ id: "C2", name: "second", archived: false, isPrivate: false });
    small.set({ id: "C3", name: "third", archived: false, isPrivate: false });

    expect(small.size).toBe(2);
    expect(small.getById("C1")).toBeUndefined(); // evicted
    expect(small.getById("C3")).toBeDefined();
  });

  it("prunes expired entries", () => {
    vi.useFakeTimers();
    try {
      cache.set({ id: "C1", name: "old", archived: false, isPrivate: false });
      vi.advanceTimersByTime(500);
      cache.set({ id: "C2", name: "new", archived: false, isPrivate: false });
      vi.advanceTimersByTime(600);

      const removed = cache.prune();
      expect(removed).toBe(1);
      expect(cache.getById("C1")).toBeUndefined();
      expect(cache.getById("C2")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears all entries", () => {
    cache.setMany([
      { id: "C1", name: "a", archived: false, isPrivate: false },
      { id: "C2", name: "b", archived: false, isPrivate: false },
    ]);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("skips entries without id or name", () => {
    cache.set({ id: "", name: "test", archived: false, isPrivate: false });
    cache.set({ id: "C1", name: "", archived: false, isPrivate: false });
    expect(cache.size).toBe(0);
  });
});

describe("default cache singleton", () => {
  afterEach(() => {
    resetDefaultChannelCache();
  });

  it("returns the same instance", () => {
    const a = getDefaultChannelCache();
    const b = getDefaultChannelCache();
    expect(a).toBe(b);
  });

  it("resets properly", () => {
    const a = getDefaultChannelCache();
    a.set({ id: "C1", name: "test", archived: false, isPrivate: false });
    resetDefaultChannelCache();
    const b = getDefaultChannelCache();
    expect(b.size).toBe(0);
    expect(a).not.toBe(b);
  });
});
