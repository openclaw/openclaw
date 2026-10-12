import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../../scripts/lib/sleep.mjs";

describe("scripts/lib/sleep.mjs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([-1, Number.NaN])("preserves the native global timer delay for %s", async (delayMs) => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      queueMicrotask(() => callback());
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await expect(sleep(delayMs)).resolves.toBeUndefined();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), delayMs);
  });
});
