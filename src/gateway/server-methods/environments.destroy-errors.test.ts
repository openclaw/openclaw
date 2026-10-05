import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { environmentsHandlers } from "./environments.js";
import {
  callEnvironmentMethod,
  FakeWorkerServiceError,
  mockContext,
  workerService,
} from "./environments.test-support.js";

describe("environment destroy errors", () => {
  it.each([
    [
      "environment_not_found",
      "unknown environmentId",
      ErrorCodes.INVALID_REQUEST,
      "unknown environmentId",
    ],
    [
      "provider_not_found",
      "private provider details",
      ErrorCodes.UNAVAILABLE,
      "worker environment destruction failed",
    ],
  ])("maps destroy %s errors", async (serviceCode, detail, code, message) => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError(serviceCode, detail);
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );
    expect(ok).toBe(false);
    expect(error).toEqual({ code, message });
  });

  it.each([
    "Crabbox stop failed with exit code 4",
    "Crabbox stop did not exit normally (timeout)",
    "Worker tunnel owner is no longer connected",
  ])("logs available %s detail while preserving the generic RPC failure", async (detail) => {
    const secret = "synthetic-destroy-bearer-value-0123456789";
    const privateContent = "private-worker-output-must-not-be-logged";
    const cause = new FakeWorkerServiceError(
      "provider_failure",
      `${detail}: Authorization: Bearer ${secret}`,
    );
    Object.assign(cause, {
      cause: { message: privateContent, proof: secret },
      stderr: privateContent,
      argv: [privateContent],
    });
    const destroyUnattached = vi.fn(async () => {
      throw cause;
    });
    const context = mockContext(workerService({ destroyUnattached }));
    const respond = vi.fn();
    await environmentsHandlers["environments.destroy"]?.({
      params: { environmentId: "worker-1" },
      respond,
      context,
    } as never);
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment destruction failed",
    });
    expect(context.logGateway.warn).toHaveBeenCalledOnce();
    const warning = context.logGateway.warn.mock.calls[0]![0];
    expect(typeof warning).toBe("string");
    expect(warning).toContain("worker-1");
    expect(warning).toContain("provider_failure");
    expect(warning).toContain(detail);
    expect(warning).not.toContain(secret);
    expect(warning).not.toContain(privateContent);
    expect(warning.length).toBeLessThanOrEqual(800);
    expect(context.logGateway.warn).toHaveBeenCalledBefore(respond);
    expect(destroyUnattached).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(context.workerPlacementDispatchService?.reconcileActive).not.toHaveBeenCalled();
  });

  it("does not serialize an unclassified thrown payload", async () => {
    const toJSON = vi.fn(() => "private-user-content");
    const context = mockContext(
      workerService({
        destroyUnattached: vi.fn().mockRejectedValue({
          code: "provider_failure",
          stderr: "private-user-content",
          toJSON,
        }),
      }),
    );
    const respond = vi.fn();
    await environmentsHandlers["environments.destroy"]?.({
      params: { environmentId: "worker-1" },
      respond,
      context,
    } as never);
    expect(context.logGateway.warn).toHaveBeenCalledOnce();
    expect(context.logGateway.warn.mock.calls[0]?.[0]).not.toContain("private-user-content");
    expect(toJSON).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment destruction failed",
    });
  });
});
