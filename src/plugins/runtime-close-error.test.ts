import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

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

it("joins explicit recovery while keeping opaque prerequisites and original diagnostics", async () => {
  const {
    PluginRuntimeCloseRetainedError,
    hasRetainedPluginRuntimeCloseError,
    createRecoverablePluginRelease,
  } = await import("./runtime-close-error.js");
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const original = new Error("resource close failed");
  let released = false;
  const recover = vi.fn(async () => {
    entered.resolve();
    await finish.promise;
    released = true;
  });
  const marker = new PluginRuntimeCloseRetainedError(original, {
    isReleased: () => released,
    recover,
  });
  const opaque = new PluginRuntimeCloseRetainedError(new Error("unverified cleanup"));
  const failure = new AggregateError([marker, opaque]);
  const dispose = vi.fn(async () => {
    throw failure;
  });
  const release = createRecoverablePluginRelease(dispose);
  const first = release();
  const observed = first.catch((error: unknown) => error);
  await entered.promise;
  expect(release()).toBe(first);
  expect(hasRetainedPluginRuntimeCloseError(marker)).toBe(true);
  finish.resolve();
  expect(await observed).toBe(failure);
  expect(marker.cause).toBe(original);
  expect(hasRetainedPluginRuntimeCloseError(marker)).toBe(false);
  expect(hasRetainedPluginRuntimeCloseError(failure)).toBe(true);
  expect(release()).toBe(first);
  expect(dispose).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledOnce();
});

it("retains custody when the owner's release probe fails", async () => {
  const {
    PluginRuntimeCloseRetainedError,
    hasRetainedPluginRuntimeCloseError,
    recoverPluginRuntimeCloseError,
  } = await import("./runtime-close-error.js");
  const failure = new Error("probe unavailable");
  const recover = vi.fn();
  const marker = new PluginRuntimeCloseRetainedError(failure, {
    isReleased: () => {
      throw failure;
    },
    recover,
  });
  expect(hasRetainedPluginRuntimeCloseError(marker)).toBe(true);
  expect(recover).not.toHaveBeenCalled();
  await recoverPluginRuntimeCloseError(marker);
  expect(hasRetainedPluginRuntimeCloseError(marker)).toBe(true);
  expect(recover).toHaveBeenCalledOnce();
});

it("shares one recovery attempt across markers for the same physical capability", async () => {
  const { PluginRuntimeCloseRetainedError, recoverPluginRuntimeCloseError } =
    await import("./runtime-close-error.js");
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let released = false;
  const recovery = {
    isReleased: () => released,
    recover: vi.fn(async () => {
      entered.resolve();
      await finish.promise;
      released = true;
    }),
  };
  const first = new PluginRuntimeCloseRetainedError(new Error("first observer"), recovery);
  const second = new PluginRuntimeCloseRetainedError(new Error("second observer"), recovery);
  const one = recoverPluginRuntimeCloseError(new AggregateError([first, second]));
  await entered.promise;
  const two = recoverPluginRuntimeCloseError(second);
  expect(recovery.recover).toHaveBeenCalledOnce();
  finish.resolve();
  await Promise.all([one, two]);
  expect(recovery.recover).toHaveBeenCalledOnce();
  expect(first.retained).toBe(false);
  expect(second.retained).toBe(false);
});
