import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { invokeEnvironment, mockContext } from "../server-methods/environments.test-support.js";
import { beforeSettlement } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

describe("worker creation request authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["valid", "installation", "provider-preparation", "provisioning-transition"] as const)(
    "admits valid creation and refuses cancelled allocation and recovery (%s)",
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
      const enterAllocation = vi.fn();
      const provider = support.createProvider({
        prepareProvision: async (_profile, _operationId, options) => {
          if (phase === "provider-preparation") {
            await hold();
          }
          return async () => {
            enterAllocation();
            options?.assertCurrent?.();
            return allocate();
          };
        },
      });
      const service = support.createService(provider);
      const cancellation = new AbortController();
      const creating = invokeEnvironment(
        "environments.create",
        { profileId: "development", idempotencyKey: "caller-authority" },
        mockContext(service),
        null,
        phase === "valid" ? () => true : undefined,
        cancellation.signal,
      );
      if (phase === "valid") {
        const result = await creating;
        expect(result[0]).toBe(true);
        expect(result[1]).toMatchObject({ worker: { state: "ready" } });
        expect(allocate).toHaveBeenCalledOnce();
        return;
      }
      try {
        await beforeSettlement(entered.promise, creating, "Creation preparation");
        cancellation.abort(new Error("Worker creation cancelled"));
      } finally {
        release.resolve();
      }
      expect(await creating).toMatchObject([
        false,
        undefined,
        { message: "worker environment creation failed" },
      ]);
      expect(enterAllocation).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
      const environment = support.testState.store.list()[0]!;
      expect(environment).toMatchObject({ state: "failed", leaseId: null });
      await service.reconcileOnce();
      await support.reopenWorkerEnvironmentStore();
      const restarted = support.createService(provider);
      await restarted.reconcileOnce();
      expect(restarted.get(environment.environmentId)?.state).toBe("failed");
      expect(enterAllocation).not.toHaveBeenCalled();
      expect(allocate).not.toHaveBeenCalled();
    },
  );
});
