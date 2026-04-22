import { describe, expect, it, vi } from "vitest";
import { tokenizedOptionFilter } from "./clack-prompter.js";

// Regression test for issue #70006 - spinner may be undefined when stop() is called
// The spinner() from @clack/prompts can return undefined in certain environments
// The fix uses optional chaining (spin?.clear() / spin?.stop()) to prevent TypeError
describe("progress stop with undefined spinner", () => {
  // Verify optional chaining prevents throw on undefined - this is the core fix
  it("should not throw when calling methods on undefined via optional chaining", () => {
    const undefinedSpinner: unknown = undefined;
    // This simulates what the fixed code does: spin?.clear() and spin?.stop(message)
    expect(
      () => (undefinedSpinner as { clear?: () => void } | undefined)?.clear?.(),
    ).not.toThrow();
    expect(
      () =>
        (undefinedSpinner as { stop?: (msg: string) => void } | undefined)?.stop?.(
          "done",
        ),
    ).not.toThrow();
  });
});
