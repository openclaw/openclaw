import { describe, expect, it } from "vitest";
import {
  crabboxProviderChain,
  normalizeCrabboxWorkload,
} from "../../scripts/crabbox-routing-policy.mts";

const advertisedProviders = ["ascii-box", "aws", "azure", "blacksmith-testbox", "daytona"];

describe("Crabbox routing policy", () => {
  it("normalizes supported workload aliases", () => {
    expect(normalizeCrabboxWorkload("check")).toBe("ci-fast");
    expect(normalizeCrabboxWorkload("release")).toBe("release-proof");
    expect(normalizeCrabboxWorkload("unknown")).toBeNull();
  });

  it.each([
    ["ci-fast", "blacksmith-testbox", "linux", ["ascii-box", "daytona", "azure", "aws"]],
    ["ci-proof", "blacksmith-testbox", "linux", ["ascii-box", "daytona", "azure", "aws"]],
    ["release-proof", "blacksmith-testbox", "linux", ["ascii-box", "daytona", "azure", "aws"]],
    ["ci-proof", "aws", "linux", ["ascii-box", "daytona", "azure", "aws"]],
    ["interactive", "blacksmith-testbox", "linux", ["daytona", "azure", "aws"]],
    ["untrusted", "blacksmith-testbox", "linux", ["azure", "aws"]],
    ["ci-fast", "blacksmith-testbox", "windows", ["azure", "aws"]],
    ["ci-fast", "blacksmith-testbox", "macos", ["aws"]],
  ] as const)("routes %s from %s on %s", (workload, configuredProvider, target, expected) => {
    expect(
      crabboxProviderChain({
        workload,
        configuredProvider,
        target,
        advertisedProviders,
      }),
    ).toEqual(expected);
  });
});
