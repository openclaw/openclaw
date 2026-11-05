import { describe, expect, it, vi } from "vitest";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createRecoveryService } from "./placement-dispatch-test-harness.js";
import { expectPlacement } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";

describe("worker placement shutdown cancellation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    { shutdown: false, destroyRequested: false },
    { shutdown: true, destroyRequested: false },
    { shutdown: true, destroyRequested: true },
  ])(
    "tears down rejected provisioning with $shutdown shutdown and $destroyRequested destroy intent",
    async ({ shutdown, destroyRequested }) => {
      const provider = support.createProvider({
        provision: async (_profile, operationId) => {
          const environment = support.testState.store
            .list()
            .find((record) => record.provisionOperationId === operationId)!;
          if (destroyRequested) {
            await support.testState.store.requestDestroy({
              environmentId: environment.environmentId,
              state: environment.state,
            });
          }
          throw new Error("provider interrupted");
        },
      });
      const environments = support.createService(provider);
      const destroy = vi.spyOn(environments, "destroy");
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const dispatch = await createRecoveryService(placements, environments, () => shutdown);

      await expect(dispatch.dispatch({ ...REQUEST, executionMode: "remote-exec" })).rejects.toThrow(
        "provider interrupted",
      );

      expectPlacement(placements, "failed");
      expect(placements.get(REQUEST.sessionId)?.terminalAtMs).not.toBeNull();
      expect(destroy).toHaveBeenCalledExactlyOnceWith(
        deriveEnvironmentIntent(`session-dispatch:${REQUEST.sessionId}:1`).environmentId,
      );
    },
  );
});
