import { describe, expect, it } from "vitest";
import {
  buildConfigChecks,
  evaluateRequirementsFromMetadata,
  resolveMissingAnyBins,
  resolveMissingBins,
  resolveMissingEnv,
  resolveMissingOs,
} from "./requirements.js";

describe("requirements helpers", () => {
  it("resolveMissingBins respects local+remote", () => {
    expect(
      resolveMissingBins({
        required: ["a", "b", "c"],
        hasLocalBin: (bin) => bin === "a",
        hasRemoteBin: (bin) => bin === "b",
      }),
    ).toEqual(["c"]);
  });

  it("resolveMissingAnyBins requires at least one", () => {
    expect(
      resolveMissingAnyBins({
        required: ["a", "b"],
        hasLocalBin: () => false,
        hasRemoteAnyBin: () => false,
      }),
    ).toEqual(["a", "b"]);
    expect(
      resolveMissingAnyBins({
        required: ["a", "b"],
        hasLocalBin: (bin) => bin === "b",
      }),
    ).toEqual([]);
  });

  it("resolveMissingOs allows remote platform", () => {
    expect(
      resolveMissingOs({
        required: ["darwin"],
        localPlatform: "linux",
        remotePlatforms: ["darwin"],
      }),
    ).toEqual([]);
    expect(resolveMissingOs({ required: ["darwin"], localPlatform: "linux" })).toEqual(["darwin"]);
  });

  it("resolveMissingEnv uses predicate", () => {
    expect(
      resolveMissingEnv({ required: ["A", "B"], isSatisfied: (name) => name === "B" }),
    ).toEqual(["A"]);
  });

  it("buildConfigChecks includes status", () => {
    expect(
      buildConfigChecks({
        required: ["a.b"],
        isSatisfied: (p) => p === "a.b",
      }),
    ).toEqual([{ path: "a.b", satisfied: true }]);
  });

  it("evaluateRequirementsFromMetadata derives required+missing", () => {
    const res = evaluateRequirementsFromMetadata({
      always: false,
      metadata: {
        requires: { bins: ["a"], anyBins: ["b"], env: ["E"], config: ["cfg.value"] },
        os: ["darwin"],
      },
      hasLocalBin: (bin) => bin === "a",
      localPlatform: "linux",
      isEnvSatisfied: (name) => name === "E",
      isConfigSatisfied: () => false,
    });

    expect(res.required.bins).toEqual(["a"]);
    expect(res.missing.config).toEqual(["cfg.value"]);
    expect(res.missing.os).toEqual(["darwin"]);
    expect(res.eligible).toBe(false);
  });
});
