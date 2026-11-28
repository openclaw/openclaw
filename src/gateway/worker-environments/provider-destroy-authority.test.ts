import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { invokeEnvironment, mockContext } from "../server-methods/environments.test-support.js";
import { hasForcedWorkerEnvironmentAbandonment } from "./environment-errors.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { beforeSettlement } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

describe("worker deletion request authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function contextFor(service: ReturnType<typeof support.createService>) {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = await createHarness(support.testState.stateDb, placements, {
      environmentService: service,
    });
    return {
      ...mockContext(service),
      workerPlacementDispatchService: coordinateWorkerPlacementDispatch(
        harness.service,
        (_request, run) => run(),
      ),
    };
  }

  it.each([false, true])(
    "queues deletion before provisioning completes (force=%s)",
    async (force) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const destroy = vi.fn(async () => {});
      const resolveAllocation = vi.fn(async () => ({ leaseId: "lease-held", sharedHost: true }));
      const service = support.createService(
        support.createProvider({
          prepareProvision: async () => {
            entered.resolve();
            await release.promise;
            return async () => {
              throw new Error("Allocation outcome requires reconciliation");
            };
          },
          resolveAllocation,
          destroy,
        }),
      );
      const deletionQueued = createDeferredCore();
      const destroyEnvironment = service.destroy;
      vi.spyOn(service, "destroy").mockImplementation((...args) => {
        const deletion = destroyEnvironment(...args);
        deletionQueued.resolve();
        return deletion;
      });
      const context = await contextFor(service);
      const creating = service.create("development", "independent-create").catch(() => undefined);
      await beforeSettlement(entered.promise, creating, "Independent create preparation");
      const original = support.testState.store.list()[0]!;
      const deleting = invokeEnvironment(
        "environments.destroy",
        { environmentId: original.environmentId, force },
        context,
        null,
        () => true,
      );
      try {
        if (force) {
          // Finish placement preflight before provisioning can fence its synchronous reads.
          await beforeSettlement(deletionQueued.promise, deleting, "Forced deletion queue handoff");
        }
        expect(support.testState.store.get(original.environmentId)).toMatchObject({
          state: "requested",
          destroyRequestedAtMs: null,
        });
      } finally {
        release.resolve();
        await creating;
      }
      const response = await deleting;
      expect(response[0], JSON.stringify(response[2])).toBe(true);
      expect(support.testState.store.get(original.environmentId)).toMatchObject({
        state: "destroyed",
        destroyRequestedAtMs: support.testState.nowMs,
      });
      expect(resolveAllocation).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["destroyed", "failed", "orphaned"] as const)(
    "accepts forced discard durably for a %s worker",
    async (state) => {
      const original = await support.seedReady("terminal-discard");
      const service = support.createService(support.createProvider());
      if (state === "destroyed") {
        await service.destroy(original.environmentId);
      } else if (state === "orphaned") {
        await support.testState.store.transition({
          environmentId: original.environmentId,
          from: "ready",
          to: "orphaned",
        });
      } else {
        await support.testState.store.requestDestroy({
          environmentId: original.environmentId,
          state: "ready",
          terminalState: "failed",
        });
        await service.destroy(original.environmentId);
      }
      let current = true;
      const discard = vi.fn(async () => {
        expect(
          hasForcedWorkerEnvironmentAbandonment(
            support.testState.store.get(original.environmentId)!,
          ),
        ).toBe(true);
        current = false;
        await Promise.resolve();
      });
      const result = await service.destroy(original.environmentId, undefined, discard, () => {
        if (!current) {
          throw new Error("Deletion requester removed");
        }
      });
      expect(result.state).toBe(state);
      expect(discard).toHaveBeenCalledOnce();
    },
  );

  it.each(["current", "removed", "maintenance"])(
    "leaves missing-worker discard to internal maintenance (requester %s)",
    async (requester) => {
      const service = support.createService(support.createProvider());
      const discard = vi.fn(async () => {});
      await expect(
        service.destroy(
          "missing-worker",
          undefined,
          discard,
          requester === "maintenance"
            ? undefined
            : () => {
                if (requester === "removed") {
                  throw new Error("Deletion requester removed");
                }
              },
        ),
      ).rejects.toThrow(requester === "removed" ? "Deletion requester removed" : "Unknown worker");
      expect(discard).toHaveBeenCalledTimes(requester === "maintenance" ? 1 : 0);
    },
  );

  it.each([false, true])(
    "finishes accepted cleanup after caller removal (force=%s)",
    async (force) => {
      const original = await support.seedReady("accepted-cleanup");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let current = true;
      const destroy = vi.fn(async () => {});
      const provider = support.createProvider({
        destroy: async (lease) => {
          entered.resolve();
          await release.promise;
          lease.signal?.throwIfAborted();
          lease.assertCurrent?.();
          await destroy();
        },
      });
      const service = support.createService(provider);
      const deleting = invokeEnvironment(
        "environments.destroy",
        { environmentId: original.environmentId, force },
        await contextFor(service),
        null,
        () => current,
      );
      try {
        await beforeSettlement(entered.promise, deleting, "Accepted provider teardown");
        expect(support.testState.store.get(original.environmentId)?.destroyRequestedAtMs).toBe(
          support.testState.nowMs,
        );
        current = false;
      } finally {
        release.resolve();
      }
      expect((await deleting)[0]).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(support.testState.store.get(original.environmentId)?.state).toBe("destroyed");
    },
  );
});
