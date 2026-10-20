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
  const start = (
    cronReconciliation: ReturnType<typeof createTestCronReconciliation>,
    overrides: Partial<Parameters<typeof startGatewayCronWithLogging>[0]> = {},
  ) => {
    startGatewayCronWithLogging({
      cronState: createTestCronState(),
      cronReconciliation,
      reason: "startup" as const,
      config: {},
      logCron: { error: vi.fn() },
      ...overrides,
    });
  };
  it("owns cron startup and completion after the requester closes", async () => {
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
    const cronReconciliation = createTestCronReconciliation(async () => {
      observed.push(callerContext.getStore());
      order.push("hook");
    });
    const cronState = createTestCronState(cron);
    const config = { cron: { enabled: true } };
    const logCron = { error: vi.fn() };

    callerWork.run(() =>
      callerContext.run("startup requester", () =>
        start(cronReconciliation, { cronState, config, logCron }),
      ),
    );
    await callerWork.drain();
    startup.resolve();

    await waitForFast(() => expect(order).toEqual(["start", "hook"]));
    expect(observed).toEqual([undefined, "started", undefined]);
    expect(cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "startup",
      config,
      cronState,
    });
    expect(logCron.error).not.toHaveBeenCalled();
  });

  it("does not complete cron reconciliation when scheduler startup rejects", async () => {
    const cron = {
      start: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("store unavailable")),
    };
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };
    const onStartError = vi.fn(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    start(cronReconciliation, {
      cronState: createTestCronState(cron),
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

  it("keeps one independent root admitted until the reconciliation hook settles", async () => {
    const hook = createDeferredCore();
    const cronReconciliation = createTestCronReconciliation(() => hook.promise);
    start(cronReconciliation);

    await waitForFast(() => expect(cronReconciliation.complete).toHaveBeenCalledTimes(1));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    hook.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
}
