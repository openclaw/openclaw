// Covers process-local dedupe cache behavior.
import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("ignores blank cache keys", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("", 100)).toBe(false);
    expect(cache.check(undefined, 100)).toBe(false);
    expect(cache.peek(null, 100)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("keeps entries indefinitely when ttlMs is zero or negative", () => {
    const zeroTtlCache = createDedupeCache({ ttlMs: 0, maxSize: 10 });
    expect(zeroTtlCache.check("a", 100)).toBe(false);
    expect(zeroTtlCache.check("a", 10_000)).toBe(true);

    const negativeTtlCache = createDedupeCache({ ttlMs: -100, maxSize: 10 });
    expect(negativeTtlCache.check("b", 100)).toBe(false);
    expect(negativeTtlCache.peek("b", 10_000)).toBe(true);
  });

  it("touches duplicate reads so the newest key survives max-size pruning", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.check("a", 300)).toBe(true);
    expect(cache.check("c", 400)).toBe(false);

    expect(cache.peek("a", 500)).toBe(true);
    expect(cache.peek("b", 500)).toBe(false);
    expect(cache.peek("c", 500)).toBe(true);

    expect(cache.check("b", 600)).toBe(false);
    expect(cache.peek("a", 700)).toBe(false);
    expect(cache.peek("b", 700)).toBe(true);
    expect(cache.peek("c", 700)).toBe(true);
  });

  it("clears itself when maxSize floors to zero", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 0.9 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 200)).toBe(false);
  });

  it("supports explicit reset", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.size()).toBe(2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 300)).toBe(false);
  });

  it("releases an owned entry only for its current owner", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });
    const staleOwner = {};
    const currentOwner = {};

    cache.check("a", 100, staleOwner);
    cache.delete("a");
    cache.check("a", 200, currentOwner);
    cache.delete("a", staleOwner);
    expect(cache.peek("a", 300)).toBe(true);
    expect(cache.check("a", 300)).toBe(true);

    cache.delete("a", currentOwner);
    expect(cache.peek("a", 400)).toBe(false);
  });

  it.each([
    {
      name: "exact TTL boundary",
      entries: [{ key: "expired", at: 100, duplicate: false }],
      now: 1_100,
      retained: ["current"],
    },
    {
      name: "older timestamp inserted after a newer entry",
      entries: [
        { key: "newer", at: 1_000, duplicate: false },
        { key: "older", at: 100, duplicate: false },
      ],
      now: 1_100,
      retained: ["newer", "current"],
    },
    {
      name: "duplicate refreshed with an older timestamp",
      entries: [
        { key: "refreshed", at: 1_000, duplicate: false },
        { key: "newer", at: 1_100, duplicate: false },
        { key: "refreshed", at: 100, duplicate: true },
      ],
      now: 1_150,
      retained: ["newer", "current"],
    },
    {
      name: "NaN timestamp alongside an expiring entry",
      entries: [
        { key: "invalid", at: Number.NaN, duplicate: false },
        { key: "expired", at: 100, duplicate: false },
      ],
      now: 1_100,
      retained: ["invalid", "current"],
    },
    {
      name: "positive Infinity cutoff",
      entries: [{ key: "expired", at: 100, duplicate: false }],
      now: Number.POSITIVE_INFINITY,
      retained: [],
    },
    {
      name: "negative Infinity cutoff",
      entries: [],
      now: Number.NEGATIVE_INFINITY,
      retained: [],
    },
  ])("prunes expired entries with $name", ({ entries, now, retained }) => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    for (const { key, at, duplicate } of entries) {
      expect(cache.check(key, at)).toBe(duplicate);
    }
    expect(cache.check("current", now)).toBe(false);

    // Observe eager pruning before a peek could delete a missed expired entry.
    expect(cache.size()).toBe(retained.length);
    for (const key of new Set([...entries.map((entry) => entry.key), "current"])) {
      expect(cache.peek(key, now)).toBe(retained.includes(key));
    }
  });
});
