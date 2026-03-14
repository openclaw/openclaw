import { describe, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "./inbound-debounce.js";

describe("createInboundDebouncer", () => {
  it("evicts oldest keys when maxKeys is exceeded", async () => {
    const flushed: string[][] = [];
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 5000,
      buildKey: (item) => item,
      onFlush: async (items) => {
        flushed.push(items);
      },
      maxKeys: 3,
    });

    // Enqueue 4 items with distinct keys — the first key should be evicted.
    await debouncer.enqueue("a");
    await debouncer.enqueue("b");
    await debouncer.enqueue("c");
    await debouncer.enqueue("d");

    // The oldest key ("a") was pruned from the buffer map by pruneMapToMaxSize.
    // Flushing "a" should be a no-op since it was already evicted.
    await debouncer.flushKey("a");
    // "b" should still be buffered.
    await debouncer.flushKey("b");

    const bFlush = flushed.find((items) => items.includes("b"));
    expect(bFlush).toEqual(["b"]);
  });

  it("uses default maxKeys of 2000 when not specified", async () => {
    const debouncer = createInboundDebouncer<string>({
      debounceMs: 1000,
      buildKey: (item) => item,
      onFlush: async () => {},
    });

    // Enqueue 2001 distinct keys.
    for (let i = 0; i < 2001; i++) {
      await debouncer.enqueue(`key-${i}`);
    }

    // The first key should have been evicted.
    const flushed: string[][] = [];
    const origDebouncer = createInboundDebouncer<string>({
      debounceMs: 1000,
      buildKey: (item) => item,
      onFlush: async (items) => {
        flushed.push(items);
      },
    });

    for (let i = 0; i < 2001; i++) {
      await origDebouncer.enqueue(`key-${i}`);
    }

    await origDebouncer.flushKey("key-0");
    // key-0 was evicted, so flushKey should produce no output.
    const key0Flush = flushed.find((items) => items.includes("key-0"));
    expect(key0Flush).toBeUndefined();

    // key-2000 should still be buffered.
    await origDebouncer.flushKey("key-2000");
    const key2000Flush = flushed.find((items) => items.includes("key-2000"));
    expect(key2000Flush).toEqual(["key-2000"]);
  });
});
