import { describe, expect, it } from "vitest";
import {
  resolveVitestPoolForWorkerClamp,
  shouldEnableTopLevelParallel,
} from "../../scripts/lib/test-parallel-policy.mjs";

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

describe("resolveVitestPoolForWorkerClamp", () => {
  it("falls back vmForks to forks when maxWorkers is 1", () => {
    expect(resolveVitestPoolForWorkerClamp({ pool: "vmForks", maxWorkers: 1 })).toBe("forks");
  });

  it("keeps vmForks when maxWorkers is greater than 1", () => {
    expect(resolveVitestPoolForWorkerClamp({ pool: "vmForks", maxWorkers: 2 })).toBe("vmForks");
  });

  it("keeps non-vm pools unchanged", () => {
    expect(resolveVitestPoolForWorkerClamp({ pool: "forks", maxWorkers: 1 })).toBe("forks");
    expect(resolveVitestPoolForWorkerClamp({ pool: "threads", maxWorkers: 1 })).toBe("threads");
  });
});
