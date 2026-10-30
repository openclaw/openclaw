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

it("retains child diagnostics", async () => {
  const { PluginRuntimeCloseRetainedError, hasRetainedPluginRuntimeCloseError } =
    await import("./runtime-close-error.js");
  const diagnostics = {
    pluginId: "signal",
    pid: 1234,
    argv0: "signal-cli",
    command: "/usr/bin/signal-cli",
    pending: {
      closingReceipt: false,
      controlClose: false,
      relayExit: true,
      stdoutEnd: true,
      stderrEnd: false,
      lineageEof: true,
      extinctionUnconfirmed: true,
    },
  } as const;
  const failure = new PluginRuntimeCloseRetainedError(
    new Error("service child cleanup did not complete"),
    diagnostics,
  );
  expect(failure.diagnostics).toEqual(diagnostics);
  expect(hasRetainedPluginRuntimeCloseError(failure)).toBe(true);
});
