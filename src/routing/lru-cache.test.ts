import { describe, expect, it } from "vitest";
import { LruMap } from "./lru-cache.js";

describe("LruMap", () => {
  it("stores and retrieves values", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    expect(lru.get("a")).toBe(1);
    expect(lru.size).toBe(1);
  });

  it("evicts oldest entry when over capacity", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.set("d", 4); // evicts "a"
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("d")).toBe(4);
    expect(lru.size).toBe(3);
  });

  it("refreshes LRU order on get", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    lru.get("a"); // refresh "a"
    lru.set("d", 4); // evicts "b" (now oldest)
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });

  it("updates existing key without eviction", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10); // update, not insert
    expect(lru.size).toBe(2);
    expect(lru.get("a")).toBe(10);
    expect(lru.get("b")).toBe(2);
  });

  it("clear removes all entries", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get("a")).toBeUndefined();
  });

  it("has returns correct result", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
  });

  it("delete removes entry", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    expect(lru.delete("a")).toBe(true);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it("throws on invalid maxSize", () => {
    expect(() => new LruMap(0)).toThrow("maxSize must be a positive integer");
    expect(() => new LruMap(-1)).toThrow("maxSize must be a positive integer");
    expect(() => new LruMap(NaN)).toThrow("maxSize must be a positive integer");
    expect(() => new LruMap(Infinity)).toThrow("maxSize must be a positive integer");
  });

  it("set on existing key refreshes LRU order for eviction", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10); // refreshes "a", "b" is now oldest
    lru.set("c", 3); // should evict "b", not "a"
    expect(lru.get("a")).toBe(10);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("c")).toBe(3);
  });
});
