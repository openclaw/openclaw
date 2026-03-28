import { describe, expect, it } from "vitest";
import { LruMap } from "./lru-map.js";

describe("LruMap", () => {
  it("throws on invalid maxSize", () => {
    expect(() => new LruMap(0)).toThrow();
    expect(() => new LruMap(-1)).toThrow();
    expect(() => new LruMap(NaN)).toThrow();
  });

  it("evicts oldest entry when maxSize exceeded", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.size).toBe(3);

    lru.set("d", 4);
    expect(lru.size).toBe(3);
    expect(lru.has("a")).toBe(false);
    expect(lru.get("b")).toBe(2);
    expect(lru.get("d")).toBe(4);
  });

  it("promotes on get", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);

    // Access "a" to promote it
    lru.get("a");

    // Now "b" is oldest
    lru.set("d", 4);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("a")).toBe(true);
  });

  it("promotes on set (update)", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);

    // Update "a" to promote it
    lru.set("a", 10);

    lru.set("d", 4);
    expect(lru.has("b")).toBe(false);
    expect(lru.get("a")).toBe(10);
  });

  it("peek does not promote", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);

    expect(lru.peek("a")).toBe(1);

    lru.set("d", 4);
    expect(lru.has("a")).toBe(false);
  });

  it("delete removes an entry", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    expect(lru.delete("a")).toBe(true);
    expect(lru.size).toBe(0);
    expect(lru.delete("a")).toBe(false);
  });

  it("clear empties the map", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
  });

  it("is iterable", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    const entries = [...lru];
    expect(entries).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
