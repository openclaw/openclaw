import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-descriptors.js";
import { environmentsHandlers, summarizeWorkerEnvironment } from "./environments.js";
import {
  callEnvironmentMethod,
  FakeWorkerServiceError,
  workerRecord,
  workerService,
} from "./environments.test-support.js";

describe("environments.prepare", () => {
  const request = { profileId: "development", projectPath: "/projects/app" };

  it("requires admin authority and ready sidecars before a control-plane write", () => {
    const descriptor = createCoreGatewayMethodDescriptors(environmentsHandlers).find(
      (entry) => entry.name === "environments.prepare",
    );
    expect(descriptor).toMatchObject({
      scope: "operator.admin",
      startup: "unavailable-until-sidecars",
      controlPlaneWrite: true,
    });
  });

  it.each([
    {},
    { profileId: "development" },
    { ...request, projectPath: "" },
    { ...request, setupAuthorized: false },
  ])("rejects invalid params before preparation: %j", async (params) => {
    const service = workerService();
    const [ok, , error] = await callEnvironmentMethod("environments.prepare", params, { service });
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it("reports when no worker service is configured", async () => {
    expect(await callEnvironmentMethod("environments.prepare", request)).toEqual([
      false,
      undefined,
      { code: ErrorCodes.INVALID_REQUEST, message: "cloud worker environments are not configured" },
    ]);
  });

  it.each([false, true])("returns the admitted preparation with reused=%s", async (reused) => {
    const result = { environmentId: "worker-1", preparationKey: "project-key", reused };
    const prepare = vi.fn(async () => result);
    expect(
      await callEnvironmentMethod("environments.prepare", request, {
        service: workerService({ prepare }),
      }),
    ).toEqual([true, result, undefined]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(request, expect.any(Function));
  });

  it.each([
    ["profile_not_found", ErrorCodes.INVALID_REQUEST, "unknown worker profile"],
    ["invalid_profile", ErrorCodes.INVALID_REQUEST, "profile cannot prepare projects"],
    ["invalid_project", ErrorCodes.INVALID_REQUEST, "project must be a local Git checkout"],
    ["capacity", ErrorCodes.UNAVAILABLE, "prepared worker pool is full"],
  ])("preserves actionable %s errors", async (code, rpcCode, message) => {
    const service = workerService({
      prepare: vi.fn(async () => {
        throw new FakeWorkerServiceError(code, message);
      }),
    });
    expect(await callEnvironmentMethod("environments.prepare", request, { service })).toEqual([
      false,
      undefined,
      { code: rpcCode, message, details: { code } },
    ]);
  });

  it("hides unknown runtime failure details", async () => {
    const service = workerService({
      prepare: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_failure", "private endpoint details");
      }),
    });
    expect(await callEnvironmentMethod("environments.prepare", request, { service })).toEqual([
      false,
      undefined,
      { code: ErrorCodes.UNAVAILABLE, message: "worker environment preparation failed" },
    ]);
  });

  it("projects preparation identity without the durable demand or expiry fields", () => {
    const preparation = {
      purpose: "build" as const,
      key: "project-key",
      demandAtMs: 1_000,
      expiresAtMs: 60_000,
      consumedAtMs: null,
    };
    expect(summarizeWorkerEnvironment(workerRecord({ preparation })).preparation).toEqual({
      purpose: "build",
      key: "project-key",
    });
    expect(summarizeWorkerEnvironment(workerRecord())).not.toHaveProperty("preparation");
  });
});
