import { describe, expect, it, vi } from "vitest";
import { invokeEnvironment, mockContext } from "../server-methods/environments.test-support.js";
import * as support from "./service.test-support.js";

describe("worker creation request authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

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
