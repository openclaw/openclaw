import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

it("recognizes retained cleanup failures from another runtime module copy", async () => {
  const first = await import("./runtime-close-error.js");
  const firstCause = new Error("first resource prerequisite failed");
  const firstFailure = new first.PluginRuntimeCloseRetainedError(firstCause);

  vi.resetModules();

  const second = await import("./runtime-close-error.js");
  const secondCause = new Error("second resource prerequisite failed");
  const secondFailure = new second.PluginRuntimeCloseRetainedError(secondCause);

  expect(firstFailure.cause).toBe(firstCause);
  expect(secondFailure.cause).toBe(secondCause);
  expect([
    first.hasRetainedPluginRuntimeCloseError(
      new AggregateError([secondFailure], "SDK cleanup failed"),
    ),
    second.hasRetainedPluginRuntimeCloseError(
      new AggregateError([firstFailure], "prepared cleanup failed"),
    ),
  ]).toEqual([true, true]);

  const ordinaryFailure = new Error("ordinary disposer failed");
  expect(first.hasRetainedPluginRuntimeCloseError(ordinaryFailure)).toBe(false);
  expect(second.hasRetainedPluginRuntimeCloseError(ordinaryFailure)).toBe(false);
});
