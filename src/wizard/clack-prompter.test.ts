// Regression test for issue #70006 - spinner may be undefined when stop() is called
// The spinner() from @clack/prompts can return undefined in certain environments
// The fix uses optional chaining (spin?.clear() / spin?.stop()) to prevent TypeError

import { describe, expect, it, vi } from "vitest";

// Track spinner mock instances for assertions
const spinnerInstances: Array<{
  start: ReturnType<typeof vi.fn>;
  message: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];

// Mock @clack/prompts before importing clack-prompter
vi.mock("@clack/prompts", () => ({
  spinner: vi.fn(() => {
    const instance = {
      start: vi.fn(),
      message: vi.fn(),
      clear: vi.fn(),
      stop: vi.fn(),
    };
    spinnerInstances.push(instance);
    return instance;
  }),
}));

import { createClackPrompter } from "./clack-prompter.js";

describe("progress stop with spinner", () => {
  beforeEach(() => {
    spinnerInstances.length = 0;
  });

  it("should call spinner.clear on stop(undefined)", () => {
    const prompter = createClackPrompter();
    const progress = prompter.progress("test label");
    progress.stop(undefined);

    // Verify clear was called (stop with undefined = clear)
    expect(spinnerInstances.length).toBeGreaterThan(0);
    expect(spinnerInstances[0].clear).toHaveBeenCalled();
  });

  it("should call spinner.stop on stop(message)", () => {
    const prompter = createClackPrompter();
    const progress = prompter.progress("test label");
    progress.stop("done");

    // Verify stop was called
    expect(spinnerInstances.length).toBeGreaterThan(0);
    expect(spinnerInstances[0].stop).toHaveBeenCalledWith("done");
  });
});