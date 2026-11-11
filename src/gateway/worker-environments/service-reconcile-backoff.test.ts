import { describe, expect, it, vi } from "vitest";
import * as support from "./service.test-support.js";

describe("worker environment reconciliation backoff", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("backs off rejected guarded recovery per environment before repeating its work", async () => {
    const failed = await support.seedReady("retry-failed");
    const healthy = await support.seedReady("retry-healthy");
    const warn = vi.fn();
    const service = support.createService(support.createProvider(), { logger: { warn } });
    const attempts: string[] = [];
    service.installReconcileEnvironmentGuard(async (id, core) => {
      attempts.push(id);
      if (id === failed.environmentId) {
        throw new Error("Workspace recovery unavailable");
      }
      await core();
    });
    await service.reconcileOnce();
    for (const [index, delay] of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
      expect(warn).toHaveBeenLastCalledWith(
        expect.stringContaining(`retryAtMs=${support.testState.nowMs + delay}`),
      );
      support.testState.nowMs += delay - 1;
      await service.reconcileOnce();
      expect(attempts.filter((id) => id === failed.environmentId)).toHaveLength(index + 1);
      support.testState.nowMs += 1;
      await service.reconcileOnce();
      expect(attempts.filter((id) => id === failed.environmentId)).toHaveLength(index + 2);
    }
    expect(attempts.filter((id) => id === healthy.environmentId)).toHaveLength(13);
  });

  it("keeps explicit recovery immediate and resets retry delay after recovery or changed teardown intent", async () => {
    const environment = await support.seedReady("retry-explicit");
    const service = support.createService(support.createProvider());
    let failing = true;
    const guard = vi.fn(async () => {
      if (failing) {
        throw new Error("Workspace recovery unavailable");
      }
    });
    service.installReconcileEnvironmentGuard(guard);
    await service.reconcileOnce();
    await service.reconcileOnce(environment.environmentId);
    expect(guard).toHaveBeenCalledTimes(2);
    failing = false;
    await service.reconcileEnvironment(environment.environmentId);
    await service.reconcileOnce();
    expect(guard).toHaveBeenCalledTimes(4);
    failing = true;
    await service.reconcileOnce();
    await service.reconcileOnce();
    expect(guard).toHaveBeenCalledTimes(5);
    await support.testState.store.requestDestroy({
      environmentId: environment.environmentId,
      state: environment.state,
    });
    await service.reconcileOnce();
    expect(guard).toHaveBeenCalledTimes(6);
    await service.stop();
    const restarted = support.createService(support.createProvider());
    restarted.installReconcileEnvironmentGuard(guard);
    await restarted.reconcileOnce();
    expect(guard).toHaveBeenCalledTimes(7);
  });
});
