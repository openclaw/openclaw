import "./update-command-execution.test-support.js";
import { expect, it, vi } from "vitest";
import { UpdatePreMutationError } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";
const { bindExecutionGuards, executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

it.each(["preparation", "staging", "validation"] as const)(
  "rejects late admission drift immediately before %s",
  async (boundary) => {
    const options = executionParams("package");
    let current = true;
    const assertCurrent = vi.fn(async () => {
      if (!current) {
        throw new UpdatePreMutationError("managed-service-preflight", "retained admission drift");
      }
    });
    await assertCurrent(); // A successful early check is not sufficient.
    options.assertPackageRuntimeCurrent = assertCurrent;
    if (boundary === "preparation") {
      const original = mocks.maybeStopService.getMockImplementation()!;
      mocks.maybeStopService.mockImplementation(async (params) => {
        const service = await original(params);
        current = false;
        return service;
      });
    } else if (boundary === "staging") {
      mocks.prepareMutableUpdate.mockImplementation(async () => {
        current = false;
      });
    } else {
      mocks.runPackageUpdate.mockImplementation(async (params) => {
        current = false;
        await params.validateCandidate("/candidate");
        return successfulUpdate;
      });
    }
    const result = await executeMutableUpdate(await bindExecutionGuards(options));
    expect(result?.result).toMatchObject({ status: "error", reason: "managed-service-preflight" });
    expect(assertCurrent).toHaveBeenCalledTimes(
      boundary === "preparation" ? 2 : boundary === "staging" ? 3 : 4,
    );
    expect(mocks.serviceStopped).toBe(false);
    expect(mocks.validateCanary).not.toHaveBeenCalled();
    if (boundary === "preparation") {
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    }
    if (boundary !== "validation") {
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    }
  },
);
