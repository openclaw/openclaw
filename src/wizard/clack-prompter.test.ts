// Regression test for issue #70006 - spinner may be undefined when stop() is called
// The spinner() from @clack/prompts can return undefined in certain environments
// The fix uses optional chaining (spin?.clear() / spin?.stop()) to prevent TypeError

import { describe, expect, it, vi } from "vitest";

// Mock @clack/prompts before importing clack-prompter
vi.mock("@clack/prompts", () => ({
  spinner: vi.fn(() => undefined), // Return undefined to simulate spinner initialization failure
}));

import { createClackPrompter } from "./clack-prompter.js";

describe("progress stop with undefined spinner", () => {
  it("should not throw on stop(undefined) when spinner is undefined", () => {
    const prompter = createClackPrompter();
    const progress = prompter.progress("test label");
    // Should not throw even though spinner is undefined
    expect(() => progress.stop(undefined)).not.toThrow();
  });

  it("should not throw on stop(message) when spinner is undefined", () => {
    const prompter = createClackPrompter();
    const progress = prompter.progress("test label");
    // Should not throw even though spinner is undefined
    expect(() => progress.stop("done")).not.toThrow();
  });
});
