import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { invokeEnvironment, mockContext } from "../server-methods/environments.test-support.js";
import { beforeSettlement } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

describe("worker creation request authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["installation", "provider-preparation", "provisioning-transition"] as const)(
    "does not allocate or recover a caller refused after %s",
    async (phase) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      if (phase === "installation") {
        support.testState.prepareInstallation = vi.fn(async () => {
          await hold();
          return support.BUNDLE_ARTIFACT;
        });
      }
      if (phase === "provisioning-transition") {
        const transition = support.testState.store.transition.bind(support.testState.store);
        vi.spyOn(support.testState.store, "transition").mockImplementation(async (request) => {
          const result = await transition(request);
          if (request.to === "provisioning") {
            await hold();
          }
          return result;
        });
      }
      const allocate = vi.fn(async () => ({
        leaseId: "lease-authorized",
        ssh: support.SSH_ENDPOINT,
      }));
      const provider = support.createProvider({
        prepareProvision: async (_profile, _operationId, options) => {
          if (phase === "provider-preparation") {
            await hold();
          }
          return async () => {
            options?.assertCurrent?.();
            return allocate();
          };
        },
      });
      const service = support.createService(provider);
      let current = true;
      const creating = invokeEnvironment(
        "environments.create",
        { profileId: "development", idempotencyKey: "caller-authority" },
        mockContext(service),
        null,
        () => current,
      );
      try {
        await beforeSettlement(entered.promise, creating, "Creation preparation");
        current = false;
      } finally {
        release.resolve();
      }
      expect((await creating)[0]).toBe(false);
      expect(allocate).not.toHaveBeenCalled();
      const environment = support.testState.store.list()[0]!;
      expect(environment).toMatchObject({ state: "failed", leaseId: null });
      await service.reconcileOnce();
      await support.reopenWorkerEnvironmentStore();
      const restarted = support.createService(provider);
      await restarted.reconcileOnce();
      expect(restarted.get(environment.environmentId)?.state).toBe("failed");
      expect(allocate).not.toHaveBeenCalled();
    },
  );

  it("completes a valid create through the same request and provider owners", async () => {
    const allocate = vi.fn(async () => ({
      leaseId: "lease-authorized",
      ssh: support.SSH_ENDPOINT,
    }));
    const service = support.createService(
      support.createProvider({
        prepareProvision: async (_profile, _operationId, options) => async () => {
          options?.assertCurrent?.();
          return allocate();
        },
      }),
    );
    const result = await invokeEnvironment(
      "environments.create",
      { profileId: "development", idempotencyKey: "valid-authority" },
      mockContext(service),
      null,
      () => true,
    );
    expect(result[0]).toBe(true);
    expect(result[1]).toMatchObject({ worker: { state: "ready" } });
    expect(allocate).toHaveBeenCalledOnce();
  });
});
