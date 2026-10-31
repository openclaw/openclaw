import { describe, expect, it, vi } from "vitest";
import { BoundedBuffer } from "./bounded-buffer.js";

describe("BoundedBuffer", () => {
  it("latches after preserving the accepted prefix", () => {
    const buffer = new BoundedBuffer<string>(3, { mode: "latch" }, (value) => value.length);
    expect(["ab", "cd", "e"].map((value) => buffer.push(value))).toEqual([true, false, false]);
    expect(buffer.drain()).toEqual(["ab"]);
  });

  it("drops every oldest value needed to fit a larger append", () => {
    const buffer = new BoundedBuffer<string>(8, { mode: "drop-oldest" }, (value) => value.length);
    expect(["a", "bb", "ccc", "dddd"].map((value) => buffer.push(value))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(buffer.drain()).toEqual(["ccc", "dddd"]);
  });

  it("clears buffered values and fails closed", () => {
    const onOverflow = vi.fn();
    const buffer = new BoundedBuffer<string>(
      3,
      { mode: "fail-closed", onOverflow },
      (value) => value.length,
    );
    expect(["ab", "cd", "e"].map((value) => buffer.push(value))).toEqual([true, false, false]);
    expect(buffer.drain()).toEqual([]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("drains the retained FIFO after sustained overflow and can then be reused", () => {
    const buffer = new BoundedBuffer<number | undefined>(3, { mode: "drop-oldest" });
    for (let value = 0; value < 5_000; value += 1) {
      buffer.push(value);
    }
    buffer.push(undefined);

    expect(buffer.drain()).toEqual([4_998, 4_999, undefined]);
    expect(buffer.drain()).toEqual([]);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.drain()).toEqual([1, 2]);
  });
});
