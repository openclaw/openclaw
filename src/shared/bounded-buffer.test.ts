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
      name: "drops oldest values until the buffer fits",
      capacity: 2,
      overflow: () => ({ mode: "drop-oldest" }),
      values: ["a", "b", "c"],
      accepted: [true, true, true],
      drained: ["b", "c"],
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

  it("skips the drop loop when the new element's measure exceeds capacity", () => {
    // measure returns 0 for first 5 calls, 15 for the 6th (the oversized element)
    let callIndex = 0;
    const measure = vi.fn(() => {
      callIndex++;
      return callIndex <= 5 ? 0 : 15;
    });
    const buffer = new BoundedBuffer<string>(10, { mode: "drop-oldest" }, measure);

    // Push 5 zero-measure elements
    for (let i = 0; i < 5; i++) {
      buffer.push("zero");
    }
    expect(measure).toHaveBeenCalledTimes(5);

    // Push oversized element (measure returns 15 > capacity 10)
    buffer.push("oversized");

    // measure was called exactly 6 times: 5 for 'zero's + 1 for 'oversized'
    // No extra calls from shift() because valueSize(15) > capacity(10) skips the loop
    expect(measure).toHaveBeenCalledTimes(6);
    expect(buffer.drain()).toEqual([]); // buffer cleared by fit/clear
  });});
