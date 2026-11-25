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

  it.each(["ci-fast", "ci-proof", "release-proof"] as const)(
    "routes %s through Boat, Daytona, Azure, then AWS",
    (workload) => {
      expect(
        crabboxProviderChain({
          workload,
          configuredProvider: "blacksmith-testbox",
          target: "linux",
          advertisedProviders,
        }),
      ).toEqual(["ascii-box", "daytona", "azure", "aws"]);
    },
  );

  it("does not let persistent cloud config outrank the CI policy", () => {
    expect(
      crabboxProviderChain({
        workload: "ci-proof",
        configuredProvider: "aws",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["ascii-box", "daytona", "azure", "aws"]);
  });

  it("prefers Daytona for interactive Linux work", () => {
    expect(
      crabboxProviderChain({
        workload: "interactive",
        configuredProvider: "blacksmith-testbox",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["daytona", "azure", "aws"]);
  });

  it("keeps untrusted work off Blacksmith and Daytona pending isolation proof", () => {
    expect(
      crabboxProviderChain({
        workload: "untrusted",
        configuredProvider: "blacksmith-testbox",
        target: "linux",
        advertisedProviders,
      }),
    ).toEqual(["azure", "aws"]);
  });

  it("uses Azure then AWS for Windows and only AWS for macOS", () => {
    expect(
      crabboxProviderChain({
        workload: "ci-fast",
        configuredProvider: "blacksmith-testbox",
        target: "windows",
        advertisedProviders,
      }),
    ).toEqual(["azure", "aws"]);
    expect(
      crabboxProviderChain({
        workload: "ci-fast",
        configuredProvider: "blacksmith-testbox",
        target: "macos",
        advertisedProviders,
      }),
    ).toEqual(["aws"]);
  });
});
