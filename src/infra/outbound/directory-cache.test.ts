import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DirectoryCache } from "./directory-cache.js";

describe("DirectoryCache", () => {
  const cfg = {} as OpenClawConfig;

  it("expires entries after ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new DirectoryCache<string>(1000, 10);

    cache.set("a", "value-a", cfg);
    expect(cache.get("a", cfg)).toBe("value-a");

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(cache.get("a", cfg)).toBeUndefined();

    vi.useRealTimers();
  });

  it("evicts oldest keys when max size is exceeded", () => {
    const cache = new DirectoryCache<string>(60_000, 2);
    cache.set("a", "value-a", cfg);
    cache.set("b", "value-b", cfg);
    cache.set("c", "value-c", cfg);

    expect(cache.get("a", cfg)).toBeUndefined();
    expect(cache.get("b", cfg)).toBe("value-b");
    expect(cache.get("c", cfg)).toBe("value-c");
  });

  it("refreshes insertion order on key updates", () => {
    const cache = new DirectoryCache<string>(60_000, 2);
    cache.set("a", "value-a", cfg);
    cache.set("b", "value-b", cfg);
    cache.set("a", "value-a2", cfg);
    cache.set("c", "value-c", cfg);

    // Updating "a" should keep it and evict older "b".
    expect(cache.get("a", cfg)).toBe("value-a2");
    expect(cache.get("b", cfg)).toBeUndefined();
    expect(cache.get("c", cfg)).toBe("value-c");
  });
});
