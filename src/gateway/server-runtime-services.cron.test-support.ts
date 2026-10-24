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
  const makeCron = (start = async () => {}, complete = async () => {}) => {
    const params = {
      cronState: createTestCronState({ start }),
      cronReconciliation: createTestCronReconciliation(complete),
      reason: "startup" as const,
      config: {},
      logCron: { error: vi.fn() },
    };
    return {
      ...params,
      start: (overrides: Partial<Parameters<typeof startGatewayCronWithLogging>[0]> = {}) =>
        startGatewayCronWithLogging({ ...params, ...overrides }),
    };
  };
  it("owns cron startup and completion after the requester closes", async () => {
    const callerContext = new AsyncLocalStorage<string>();
    const callerWork = new AsyncWorkScope();
    const startup = createDeferredCore();
    const observed: unknown[] = [];
    const cron = makeCron(
      async () => {
        await startup.promise;
        observed.push(callerContext.getStore());
        observed.push(await trackAsyncWork(() => "started").catch((error: unknown) => error));
      },
      async () => {
        observed.push(callerContext.getStore());
      },
    );
    const config = { cron: { enabled: true } };
    callerWork.run(() => callerContext.run("startup requester", () => cron.start({ config })));
    await callerWork.drain();
    startup.resolve();

    // The hook's observation comes last only after scheduler startup completes.
    await waitForFast(() => expect(observed).toEqual([undefined, "started", undefined]));
    expect(cron.cronReconciliation.arm).toHaveBeenCalledWith({
      reason: "startup",
      config,
      cronState: cron.cronState,
    });
    expect(cron.logCron.error).not.toHaveBeenCalled();
  });

  it("does not complete cron reconciliation when scheduler startup rejects", async () => {
    const cron = makeCron(async () => {
      throw new Error("store unavailable");
    });
    const onStartError = vi.fn(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });
    cron.start({ onStartError });
    await waitForFast(() =>
      expect(cron.logCron.error).toHaveBeenCalledWith("failed to start: Error: store unavailable"),
    );
    expect(onStartError).toHaveBeenCalledOnce();
    expect(cron.cronReconciliation.complete).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps one independent root admitted until the reconciliation hook settles", async () => {
    const hook = createDeferredCore();
    const cron = makeCron(undefined, () => hook.promise);
    cron.start();
    await waitForFast(() => expect(cron.cronReconciliation.complete).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    hook.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });
}
