import { describe, expect, it } from "vitest";
import { LruCache } from "./lru-cache.js";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string>(2);

    cache.set("", "empty");
    cache.set("a", "alpha");
    cache.set("b", "bravo");
    expect(cache.get("a")).toBe("alpha");

    cache.set("c", "charlie");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("c")).toBe("charlie");
  });

  it.each([null, undefined])("retains cached %s values", (value) => {
    const cache = new LruCache<string | null | undefined>(2);

    cache.set("retained", value);
    cache.set("older", "old");

    expect(cache.get("retained")).toBe(value);
    cache.set("newest", "new");
    expect([...cache.keys()]).toEqual(["retained", "newest"]);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("does not promote a peeked entry before revalidation settles", () => {
    const cache = new LruCache<string>(2);
    cache.set("first", "one");
    cache.set("second", "two");

    expect(cache.peek("first")).toBe("one");
    cache.set("third", "three");

    expect([...cache.keys()]).toEqual(["second", "third"]);
  });

  it("reclaims byte capacity on replacement, deletion, and clear", () => {
    const cache = new LruCache<string>(10, { maxBytes: 5, sizeOf: (value) => value.length });
    cache.set("first", "aaa");
    cache.set("second", "bb");
    cache.set("first", "a");
    cache.set("third", "cc");
    expect([...cache.keys()]).toEqual(["second", "first", "third"]);

    cache.delete("second");
    cache.set("fourth", "dd");
    expect([...cache.keys()]).toEqual(["first", "third", "fourth"]);

    cache.deleteValue("cc");
    cache.set("fifth", "ee");
    expect([...cache.keys()]).toEqual(["first", "fourth", "fifth"]);

    cache.clear();
    cache.set("last", "12345");
    expect(cache.get("last")).toBe("12345");
  });

  it("evicts older entries and then an oversized newest entry", () => {
    const cache = new LruCache<string>(2, { maxBytes: 3, sizeOf: (value) => value.length });
    cache.set("first", "a");
    cache.set("second", "b");
    cache.set("oversized", "1234");

    expect(cache.size).toBe(0);
    cache.set("next", "abc");
    expect(cache.get("next")).toBe("abc");
  });
});
