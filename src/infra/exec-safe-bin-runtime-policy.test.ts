import { describe, expect, it } from "vitest";
import {
  isInterpreterLikeSafeBin,
  listInterpreterLikeSafeBins,
  resolveExecSafeBinRuntimePolicy,
  resolveMergedSafeBinProfileFixtures,
} from "./exec-safe-bin-runtime-policy.js";

describe("exec safe-bin runtime policy", () => {
  const interpreterCases: Array<{ bin: string; expected: boolean }> = [
    { bin: "python3", expected: true },
    { bin: "python3.12", expected: true },
    { bin: "node", expected: true },
    { bin: "node20", expected: true },
    { bin: "ruby3.2", expected: true },
    { bin: "bash", expected: true },
    { bin: "myfilter", expected: false },
    { bin: "jq", expected: false },
  ];

  for (const testCase of interpreterCases) {
    it(`classifies interpreter-like safe bin '${testCase.bin}'`, () => {
      expect(isInterpreterLikeSafeBin(testCase.bin)).toBe(testCase.expected);
    });
  }

  it("lists interpreter-like bins from a mixed set", () => {
    expect(listInterpreterLikeSafeBins(["jq", "python3", "myfilter", "node"])).toEqual([
      "node",
      "python3",
    ]);
  });

  it("merges and normalizes safe-bin profile fixtures", () => {
    const merged = resolveMergedSafeBinProfileFixtures({
      global: {
        safeBinProfiles: {
          " MyFilter ": {
            deniedFlags: ["--file", " --file ", ""],
          },
        },
      },
      local: {
        safeBinProfiles: {
          myfilter: {
            maxPositional: 0,
          },
        },
      },
    });
    expect(merged).toEqual({
      myfilter: {
        maxPositional: 0,
      },
    });
  });

  it("computes unprofiled interpreter entries separately from custom profiled bins", () => {
    const policy = resolveExecSafeBinRuntimePolicy({
      local: {
        safeBins: ["python3", "myfilter"],
        safeBinProfiles: {
          myfilter: { maxPositional: 0 },
        },
      },
    });

    expect(policy.safeBins.has("python3")).toBe(true);
    expect(policy.safeBins.has("myfilter")).toBe(true);
    expect(policy.unprofiledSafeBins).toEqual(["python3"]);
    expect(policy.unprofiledInterpreterSafeBins).toEqual(["python3"]);
  });
});
