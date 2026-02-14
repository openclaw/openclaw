import { describe, expect, it } from "vitest";
import {
  buildConfigChecks,
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

  it("buildConfigChecks includes value+status", () => {
    expect(
      buildConfigChecks({
        required: ["a.b"],
        resolveValue: (p) => (p === "a.b" ? 1 : null),
        isSatisfied: (p) => p === "a.b",
      }),
    ).toEqual([{ path: "a.b", value: 1, satisfied: true }]);
  });
});
