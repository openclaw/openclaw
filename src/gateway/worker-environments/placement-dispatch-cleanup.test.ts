import { describe, expect, it, vi } from "vitest";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("worker placement cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("preserves the dispatch error when cleanup advances the placement generation", async () => {
    const placementStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    let newerPlacement: Awaited<ReturnType<typeof placementStore.fail>> | undefined;
    const harness = await createHarness(support.testState.stateDb, placementStore, {
      failAt: "sync",
      afterDestroy: async () => {
        const current = await placementStore.getAsync(REQUEST.sessionId);
        if (!current) {
          throw new Error("expected dispatch placement");
        }
        newerPlacement = await placementStore.fail({
          sessionId: REQUEST.sessionId,
          expectedGeneration: current.generation,
          recoveryError: "newer cleanup failure",
        });
      },
    });

    const error = await harness.service.dispatch(REQUEST).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: expect.stringContaining("sync failed"),
      errors: [
        expect.objectContaining({ message: "sync failed" }),
        expect.objectContaining({ message: expect.stringContaining("changed before failure") }),
      ],
      cause: expect.objectContaining({
        message: expect.stringContaining("changed before failure"),
      }),
    });
    expect(await placementStore.getAsync(REQUEST.sessionId)).toEqual(newerPlacement);
  });

  it("retries pending failed-environment teardown before clearing the placement", async () => {
    const placementStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = await createHarness(support.testState.stateDb, placementStore, {
      failAt: "sync",
      destroyFails: true,
      destroyFailureState: "destroying",
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("environment destroy: destroy pending"),
    });
    const originalFailure = harness.placements.current()?.recoveryError;

    await harness.service.reconcileActive();
    await harness.service.reconcileActive();
    expect(harness.placements.current()).toMatchObject({
      recoveryError: originalFailure,
      terminalReason: originalFailure,
    });

    const cleanupError = "release is pending; retry after provider cleanup advances";
    vi.mocked(harness.environments.destroy).mockRejectedValueOnce(new Error(cleanupError));
    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(cleanupError);
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      environmentId: harness.attached.environmentId,
      recoveryError: `${originalFailure}; environment destroy: ${cleanupError}`,
      terminalReason: originalFailure,
    });
    expect(harness.environments.get(harness.attached.environmentId)).toMatchObject({
      state: "destroying",
    });

    const latestCause = "provider cleanup rejected the resource identity";
    const latestError = `provider cleanup ${"progress ".repeat(200)}${latestCause}`;
    vi.mocked(harness.environments.destroy).mockRejectedValue(new Error(latestError));
    await harness.service.reconcileActive();
    const latestFailure = harness.placements.current()?.recoveryError;
    expect(latestFailure).toContain("sync failed");
    expect(latestFailure).toContain(latestCause);
    expect(latestFailure).not.toContain(cleanupError);
    expect(latestFailure!.length).toBeLessThanOrEqual(1_024);
    await harness.service.reconcileActive();
    expect(harness.placements.current()).toMatchObject({
      recoveryError: latestFailure,
      terminalReason: originalFailure,
    });

    vi.mocked(harness.environments.destroy).mockImplementationOnce(async () => {
      harness.markEnvironmentDestroyed();
      const destroyed = harness.environments.get(harness.attached.environmentId);
      if (!destroyed) {
        throw new Error("expected destroyed environment");
      }
      return destroyed;
    });
    await expect(
      harness.service.reclaim({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
      }),
    ).resolves.toMatchObject({ state: "local" });
    expect(harness.environments.destroy).toHaveBeenCalledTimes(7);
  });
});
