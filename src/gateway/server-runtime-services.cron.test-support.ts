import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createTestCronReconciliation,
  createTestCronState,
  waitForFast,
} from "./server-runtime-services.test-harness.js";

export function registerGatewayCronStartupTests(
  startGatewayCronWithLogging: typeof import("./server-runtime-services.js").startGatewayCronWithLogging,
) {
  it("owns cron startup, watcher reconciliation, and completion after the requester closes", async () => {
    const order: string[] = [];
    const callerContext = new AsyncLocalStorage<string>();
    const callerWork = new AsyncWorkScope();
    const startup = createDeferredCore();
    const observed: unknown[] = [];
    const cron = {
      start: vi.fn(async () => {
        await startup.promise;
        observed.push(callerContext.getStore());
        observed.push(await trackAsyncWork(() => "started").catch((error: unknown) => error));
        order.push("start");
      }),
    };
    const afterStart = vi.fn(async () => {
      observed.push(callerContext.getStore());
      order.push("after-start");
    });
    const cronReconciliation = createTestCronReconciliation(async () => {
      observed.push(callerContext.getStore());
      order.push("hook");
    });
    const cronState = createTestCronState(cron);
    const config = { cron: { enabled: true } } as never;
    const logCron = { error: vi.fn() };

    callerWork.run(() =>
      callerContext.run("startup requester", () =>
        startGatewayCronWithLogging({
          cronState,
          cronReconciliation,
          reason: "startup",
          config,
          afterStart,
          logCron,
        }),
      ),
    );
    await callerWork.drain();
    startup.resolve();

    await waitForFast(() => expect(order).toEqual(["start", "after-start", "hook"]));
    expect(observed).toEqual([undefined, "started", undefined, undefined]);
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "startup",
      config,
      cronState,
    });
    expect(logCron.error).not.toHaveBeenCalled();
  });

  it("does not complete cron reconciliation when scheduler startup rejects", async () => {
    const cron = {
      start: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };
    const onStartError = vi.fn(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    startGatewayCronWithLogging({
      cronState: createTestCronState(cron),
      cronReconciliation,
      reason: "startup",
      config: {} as never,
      onStartError,
      logCron,
    });

    await waitForFast(() =>
      expect(logCron.error).toHaveBeenCalledWith("failed to start: Error: store unavailable"),
    );
    expect(onStartError).toHaveBeenCalledOnce();
    expect(cronReconciliation.complete).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("does not complete cron reconciliation when exit-watcher reconciliation rejects", async () => {
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };

    startGatewayCronWithLogging({
      cronState: createTestCronState(),
      cronReconciliation,
      reason: "reload",
      config: {} as never,
      afterStart: async () => {
        throw new Error("watcher unavailable");
      },
      logCron,
    });

    await waitForFast(() =>
      expect(logCron.error).toHaveBeenCalledWith("failed to start: Error: watcher unavailable"),
    );
    expect(cronReconciliation.complete).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps one independent root admitted until the reconciliation hook settles", async () => {
    let releaseHook: (() => void) | undefined;
    const cronReconciliation = createTestCronReconciliation(
      () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    );

    startGatewayCronWithLogging({
      cronState: createTestCronState(),
      cronReconciliation,
      reason: "startup",
      config: {} as never,
      logCron: { error: vi.fn() },
    });

    await waitForFast(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    if (!releaseHook) {
      throw new Error("Expected cron reconciliation hook to be pending");
    }
    releaseHook();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
}
