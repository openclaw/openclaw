import { describe, expect, it, vi } from "vitest";
import { dispatchNodeInvokeInput, registerNodeInvokeInputHandler } from "./runtime.js";

function createTarget() {
  return {
    nextInputSeq: 0,
    pendingInput: [] as Array<{ payloadJSON: string; bytes: number }>,
    pendingInputBytes: 0,
    inputFailed: false,
    abort: vi.fn(),
  };
}

describe("node-host invoke input dispatch", () => {
  it("buffers frames before registration and flushes them in order", () => {
    const input = vi.fn();
    const target = createTarget();

    expect(dispatchNodeInvokeInput(target, 0, "first")).toBe(true);
    expect(dispatchNodeInvokeInput(target, 1, "second")).toBe(true);
    expect(input).not.toHaveBeenCalled();

    registerNodeInvokeInputHandler(target, input);
    expect(input.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("drops duplicate sequence numbers", () => {
    const input = vi.fn();
    const target = createTarget();
    registerNodeInvokeInputHandler(target, input);

    expect(dispatchNodeInvokeInput(undefined, 0, "unknown")).toBe(false);
    expect(dispatchNodeInvokeInput(target, 0, "first")).toBe(true);
    expect(dispatchNodeInvokeInput(target, 0, "duplicate")).toBe(false);
    expect(dispatchNodeInvokeInput(target, 1, "second")).toBe(true);
    expect(input.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("aborts without delivering partial input when the pre-spawn buffer overflows", () => {
    const input = vi.fn();
    const target = createTarget();
    const chunk = "x".repeat(16 * 1024 - 1);

    for (let seq = 0; seq < 4; seq += 1) {
      expect(dispatchNodeInvokeInput(target, seq, `${seq}${chunk}`)).toBe(true);
    }
    expect(dispatchNodeInvokeInput(target, 4, `4${chunk}`)).toBe(false);
    registerNodeInvokeInputHandler(target, input);
    expect(input).not.toHaveBeenCalled();
    expect(target.pendingInput).toEqual([]);
    expect(target.abort).toHaveBeenCalledOnce();
    expect(dispatchNodeInvokeInput(target, 5, "continued")).toBe(false);
  });

  it("tolerates sequence gaps", () => {
    const input = vi.fn();
    const target = createTarget();
    registerNodeInvokeInputHandler(target, input);

    expect(dispatchNodeInvokeInput(target, 2, "gap")).toBe(true);
    expect(dispatchNodeInvokeInput(target, 3, "next")).toBe(true);
    expect(input.mock.calls).toEqual([["gap"], ["next"]]);
  });
});
