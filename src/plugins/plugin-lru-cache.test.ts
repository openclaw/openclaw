import { describe, expect, it } from "vitest";
import { PluginLruCache } from "./plugin-lru-cache.js";

describe("PluginLruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new PluginLruCache<string>(2);

    cache.set("", "empty");
    cache.set("a", "alpha");
    cache.set("b", "bravo");
    expect(cache.get("a")).toBe("alpha");

    cache.set("c", "charlie");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("c")).toBe("charlie");
  });

  it("distinguishes cached null values from misses", () => {
    const cache = new PluginLruCache<string | null>(2);

    cache.set("missing", null);

    expect(cache.get("missing")).toBeNull();
    expect(cache.get("unknown")).toBeUndefined();
  });
});
