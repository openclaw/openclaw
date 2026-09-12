import { describe, expect, it, vi } from "vitest";
import { BoundedBuffer } from "./bounded-buffer.js";

type Overflow = ConstructorParameters<typeof BoundedBuffer<string>>[1];

describe("BoundedBuffer", () => {
  it.each<{
    name: string;
    capacity: number;
    measure?: (value: string) => number;
    overflow: (onOverflow: () => void) => Overflow;
    values: string[];
    accepted: boolean[];
    drained: string[];
    overflowCalls: number;
  }>([
    {
      name: "latches after preserving the accepted prefix",
      capacity: 3,
      measure: (value) => value.length,
      overflow: () => ({ mode: "latch" }),
      values: ["ab", "cd", "e"],
      accepted: [true, false, false],
      drained: ["ab"],
      overflowCalls: 0,
    },
    {
      name: "drops every oldest value needed to fit a larger append",
      capacity: 8,
      measure: (value) => value.length,
      overflow: () => ({ mode: "drop-oldest" }),
      values: ["a", "bb", "ccc", "dddd"],
      accepted: [true, true, true, true],
      drained: ["ccc", "dddd"],
      overflowCalls: 0,
    },
    {
      name: "clears buffered values and fails closed",
      capacity: 3,
      measure: (value) => value.length,
      overflow: (onOverflow) => ({ mode: "fail-closed", onOverflow }),
      values: ["ab", "cd", "e"],
      accepted: [true, false, false],
      drained: [],
      overflowCalls: 1,
    },
  ])("$name", ({ capacity, measure, overflow, values, accepted, drained, overflowCalls }) => {
    const onOverflow = vi.fn();
    const buffer = new BoundedBuffer(capacity, overflow(onOverflow), measure);

    expect(values.map((value) => buffer.push(value))).toEqual(accepted);
    expect(buffer.drain()).toEqual(drained);
    expect(onOverflow).toHaveBeenCalledTimes(overflowCalls);
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
