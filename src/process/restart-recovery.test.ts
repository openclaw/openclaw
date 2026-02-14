import { describe, expect, it, vi } from "vitest";
import { createRestartIterationHook } from "./restart-recovery.js";

describe("restart-recovery", () => {
  it("skips recovery on first iteration and runs on subsequent iterations", () => {
    const onRestart = vi.fn();
    const onIteration = createRestartIterationHook(onRestart);

    expect(onIteration()).toBe(false);
    expect(onRestart).not.toHaveBeenCalled();

    expect(onIteration()).toBe(true);
    expect(onRestart).toHaveBeenCalledTimes(1);

    expect(onIteration()).toBe(true);
    expect(onRestart).toHaveBeenCalledTimes(2);
  });
});
