import { describe, expect, it } from "vitest";
import { parseGatewayStabilityRuntimeOptions } from "./gateway-stability-runtime-contract.js";

describe("gateway stability runtime CLI", () => {
  it("requires one bounded artifact destination", () => {
    expect(parseGatewayStabilityRuntimeOptions(["--artifact-base", "artifacts"], "/repo")).toEqual({
      artifactBase: "/repo/artifacts",
      repoRoot: "/repo",
    });
    expect(() => parseGatewayStabilityRuntimeOptions([])).toThrow("--artifact-base is required");
    expect(() => parseGatewayStabilityRuntimeOptions(["--artifact-base", "--other"])).toThrow(
      "--artifact-base requires a value",
    );
  });
});
