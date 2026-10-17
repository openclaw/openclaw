import process from "node:process";
import { expect, it, vi, type MockInstance } from "vitest";
import { registerActiveDebugProxyCapture } from "../proxy-capture/runtime-cleanup.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPendingCliDisposers } from "./runtime-cleanup.js";
import * as signalExit from "./signal-exit-barrier.js";

export const makeProxyHandle = () => ({
  proxyUrl: "http://127.0.0.1:19876",
  stop: vi.fn(async () => {}),
  kill: vi.fn(),
});

async function waitForHandler(spy: MockInstance<typeof process.once>, event: string) {
  await vi.waitFor(() => expect(spy.mock.calls.filter(([name]) => name === event)).toHaveLength(1));
  const handler = spy.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof handler !== "function") {
    throw new Error(`${event} handler was not registered`);
  }
  return handler;
}

export function registerRunMainProxyExitTests(
  fixture: typeof import("./run-main.test-support.js"),
): void {
  const { startProxyMock, stopProxyMock, tryRouteCliMock } = fixture;
  function prepareCommand() {
    const handle = makeProxyHandle();
    const route = createDeferredCore<boolean>();
    startProxyMock.mockResolvedValueOnce(handle);
    tryRouteCliMock.mockReturnValueOnce(route.promise);
    return {
      handle,
      route,
      run: () => fixture.runCli(fixture.cliArgs("plugins", "marketplace", "list")),
    };
  }
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "stops the managed proxy and drains capture before %s exit",
    async (signal, exitCode) => {
      const previousExitCode = process.exitCode;
      const { handle, route, run } = prepareCommand();
      const processOnceSpy = vi.spyOn(process, "once");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const companionCleanup = createDeferredCore();
      const drainCompanion = vi.fn(() => companionCleanup.promise);
      const unregisterCompanionCleanup = signalExit.registerSignalExitBarrier(drainCompanion);
      const captureFinished = createDeferredCore();
      const cleanupOrder: string[] = [];
      const captureFinalizer = vi.fn(async () => {
        await captureFinished.promise;
        cleanupOrder.push("capture");
        unregisterCapture();
      });
      const unregisterCapture = registerActiveDebugProxyCapture(captureFinalizer);
      const retireWorkerSource = vi.fn(async () => void cleanupOrder.push("worker-source"));
      const unregisterWorkerSource = signalExit.registerSignalExitFinalizer(retireWorkerSource);
      const runPromise = run();
      try {
        const signalHandler = await waitForHandler(processOnceSpy, signal);
        signalHandler();
        await vi.waitFor(() => expect(stopProxyMock).toHaveBeenCalledWith(handle));
        expect(exitSpy).not.toHaveBeenCalled();
        expect(drainCompanion).toHaveBeenCalled();
        companionCleanup.resolve();
        await vi.waitFor(() => expect(captureFinalizer).toHaveBeenCalledOnce());
        expect(exitSpy).not.toHaveBeenCalled();
        expect(retireWorkerSource).not.toHaveBeenCalled();
        captureFinished.resolve();
        expect(await signalExit.waitForCliSignalExit()).toBe(exitCode);
        expect(process.exitCode).toBe(exitCode);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(cleanupOrder).toEqual(["capture", "worker-source"]);

        route.resolve(true);
        await runPromise;
        expect(stopProxyMock).toHaveBeenCalledTimes(1);
        expect(captureFinalizer).toHaveBeenCalledOnce();
      } finally {
        captureFinished.resolve();
        companionCleanup.resolve();
        route.resolve(true);
        try {
          await runPromise;
        } finally {
          unregisterCompanionCleanup();
          unregisterCapture();
          unregisterWorkerSource();
          await signalExit.waitForSignalExitBarriers();
          await signalExit.waitForCliSignalExit();
          process.exitCode = previousExitCode;
          exitSpy.mockRestore();
          processOnceSpy.mockRestore();
        }
      }
    },
  );

  it("keeps the original signal proxy stop pending through bounded command cleanup", async () => {
    const { handle, route, run } = prepareCommand();
    const stopping = createDeferredCore();
    const resume = createDeferredCore();
    stopProxyMock.mockImplementationOnce(async () => {
      stopping.resolve();
      await resume.promise;
    });
    const running = run();
    let barrier: Promise<void> | undefined;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await vi.waitFor(() => expect(tryRouteCliMock).toHaveBeenCalled());
      barrier = signalExit.waitForSignalExitBarriers();
      await stopping.promise;
      vi.useFakeTimers();
      route.resolve(true);
      await vi.waitFor(() => expect(getPendingCliDisposers()).toContain("managed-proxy"));
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      expect(getPendingCliDisposers()).toContain("managed-proxy");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("managed-proxy"));
      expect(stopProxyMock).toHaveBeenCalledExactlyOnceWith(handle);
    } finally {
      route.resolve(true);
      resume.resolve();
      vi.useRealTimers();
      await barrier;
      await running;
      stderr.mockRestore();
    }
    expect(getPendingCliDisposers()).not.toContain("managed-proxy");
  });

  it("synchronously kills the managed proxy during hard process exit", async () => {
    const { handle, route, run } = prepareCommand();
    const processOnceSpy = vi.spyOn(process, "once");
    try {
      const runPromise = run();
      const exitHandler = await waitForHandler(processOnceSpy, "exit");
      exitHandler(0 as never);

      expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
      route.resolve(true);
      await runPromise;
      expect(stopProxyMock).not.toHaveBeenCalledWith(handle);
    } finally {
      processOnceSpy.mockRestore();
    }
  });
}
