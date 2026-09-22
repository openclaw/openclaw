import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

afterEach(() => vi.resetModules());

it("recognizes drain settlement diagnostics from another runtime module copy", async () => {
  const first = await import("./plugin-instance-error.js");
  const pending = createDeferredCore();
  const cause = new Error("original call still running");
  const firstFailure = new first.PluginInstanceDrainTimeoutError("timed out", pending.promise, {
    cause,
  });
  vi.resetModules();
  const second = await import("./plugin-instance-error.js");
  const secondFailure = new second.PluginInstanceDrainTimeoutError("timed out", pending.promise, {
    cause,
  });
  expect(second).not.toBe(first);
  expect(firstFailure).toBeInstanceOf(second.PluginInstanceDrainTimeoutError);
  expect(secondFailure).toBeInstanceOf(first.PluginInstanceDrainTimeoutError);
  expect(firstFailure.settled).toBe(pending.promise);
  expect(secondFailure.cause).toBe(cause);
  expect(new Error("resource cleanup failed")).not.toBeInstanceOf(
    second.PluginInstanceDrainTimeoutError,
  );
  pending.resolve();
  await firstFailure.settled;
});
