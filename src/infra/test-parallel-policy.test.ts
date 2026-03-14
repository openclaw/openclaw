import { describe, expect, it } from "vitest";
import { shouldEnableTopLevelParallel } from "../../scripts/lib/test-parallel-policy.mjs";

describe("shouldEnableTopLevelParallel", () => {
  it("disables top-level lane parallelism in CI to avoid memory spikes", () => {
    expect(shouldEnableTopLevelParallel({ isCI: true, testProfile: "normal" })).toBe(false);
    expect(shouldEnableTopLevelParallel({ isCI: true, testProfile: "max" })).toBe(false);
  });

  it("keeps local normal/max profiles parallel", () => {
    expect(shouldEnableTopLevelParallel({ isCI: false, testProfile: "normal" })).toBe(true);
    expect(shouldEnableTopLevelParallel({ isCI: false, testProfile: "max" })).toBe(true);
  });

  it("keeps low/serial profiles non-parallel locally", () => {
    expect(shouldEnableTopLevelParallel({ isCI: false, testProfile: "low" })).toBe(false);
    expect(shouldEnableTopLevelParallel({ isCI: false, testProfile: "serial" })).toBe(false);
  });
});
