import { describe, expect, it } from "vitest";
import { createInboundDebouncer } from "./inbound-debounce.js";

describe("createInboundDebouncer", () => {
  it("flushes evicted items when maxKeys is exceeded", async () => {
    const flushed: string[][] = [];
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 5000,
      buildKey: (item) => item,
      onFlush: async (items) => {
        flushed.push(items);
      },
      maxKeys: 3,
    });

    // Enqueue 4 items with distinct keys — the first key should be evicted and flushed.
    await debouncer.enqueue("a");
    await debouncer.enqueue("b");
    await debouncer.enqueue("c");
    await debouncer.enqueue("d");

    // Allow the fire-and-forget eviction flush to settle.
    await new Promise((r) => setTimeout(r, 10));

    // "a" was evicted and its buffered items were flushed immediately.
    const aFlush = flushed.find((items) => items.includes("a"));
    expect(aFlush).toEqual(["a"]);

    // "a" is no longer in the buffer, so flushKey is a no-op.
    const flushedBefore = flushed.length;
    await debouncer.flushKey("a");
    expect(flushed.length).toBe(flushedBefore);

    // "b" should still be buffered.
    await debouncer.flushKey("b");
    const bFlush = flushed.find((items) => items.includes("b"));
    expect(bFlush).toEqual(["b"]);
  });

  it("uses default maxKeys of 2000 when not specified", async () => {
    const flushed: string[][] = [];
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 1000,
      buildKey: (item) => item,
      onFlush: async (items) => {
        flushed.push(items);
      },
    });

    // Enqueue 2001 distinct keys.
    for (let i = 0; i < 2001; i++) {
      await debouncer.enqueue(`key-${i}`);
    }

    // Allow eviction flushes to settle.
    await new Promise((r) => setTimeout(r, 10));

    // key-0 was evicted and flushed during eviction.
    const key0Flush = flushed.find((items) => items.includes("key-0"));
    expect(key0Flush).toEqual(["key-0"]);

    // key-0 is no longer in the buffer map.
    const flushedBefore = flushed.length;
    await debouncer.flushKey("key-0");
    expect(flushed.length).toBe(flushedBefore);

    // key-2000 should still be buffered.
    await debouncer.flushKey("key-2000");
    const key2000Flush = flushed.find((items) => items.includes("key-2000"));
    expect(key2000Flush).toEqual(["key-2000"]);
  });
});
