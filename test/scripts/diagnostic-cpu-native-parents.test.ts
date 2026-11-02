import type { Profiler } from "node:inspector";
import { describe, expect, it } from "vitest";
import { attributeNativeCpuSamples } from "../../scripts/diagnostic-cpu-native-parents.mts";

function profile(): Profiler.Profile {
  const nodes: [number, string, string?, number[]?][] = [
    [1, "(root)", "", [2, 6, 7]],
    [2, "start", "openclaw:src/logging/diagnostic-cpu-profile.ts", [3]],
    [3, "post", "node:inspector", [4]],
    [4, "[native]", "", [5]],
    [5, "callback", "openclaw:src/callback.ts"],
    [6, "(idle)"],
    [7, "read", "openclaw:src/read.ts", [8]],
    [8, "[native]", "", [9]],
    [9, "[native]"],
  ];
  return {
    nodes: nodes.map(([id, functionName, url = "", children = []]) => ({
      id,
      children,
      callFrame: {
        functionName,
        url,
        scriptId: url ? "1" : "0",
        lineNumber: url ? 9 : -1,
        columnNumber: url ? 0 : -1,
      },
    })),
    startTime: 0,
    endTime: 1_000_000,
    samples: [4, 6, 9, 5, 8],
    timeDeltas: [200_000, 500_000, 100_000, 100_000, 100_000],
  };
}

describe("native CPU sample attribution", () => {
  it("weights self time by deltas and walks past native parents without charging JS children", () => {
    const value = profile();
    value.nodes[7]!.callFrame.scriptId = "-1";
    expect(attributeNativeCpuSamples(value)).toMatchObject({
      windowMs: 1_000,
      nativeMs: 400,
      nativePercent: 40,
      startupSampleMs: 0,
      workloadNativePercent: 40,
      parents: ["post node:inspector:10:1", "read openclaw:src/read.ts:10:1"].map((parent) => ({
        parent,
        nativeMs: 200,
        windowPercent: 20,
        nativePercent: 50,
      })),
    });
  });

  it("separates only the identified startup sample and preserves the complete profile", () => {
    const input = { profile: profile(), startBlockedMs: 201 };
    const original = structuredClone(input);
    expect(attributeNativeCpuSamples(input)).toMatchObject({
      nativePercent: 40,
      startBlockedMs: 201,
      startupSampleMs: 200,
      workloadWindowMs: 800,
      workloadNativePercent: 25,
      parents: [
        { parent: "post node:inspector:10:1", workloadPercent: 0 },
        { parent: "read openclaw:src/read.ts:10:1", workloadPercent: 25 },
      ],
    });
    expect(input).toEqual(original);
    input.profile.samples = [6, 4];
    input.profile.timeDeltas = [500_000, 200_000];
    expect(attributeNativeCpuSamples(input).startupSampleMs).toBe(0);
    input.profile.samples = [8];
    input.profile.timeDeltas = [200_000];
    expect(attributeNativeCpuSamples(input).startupSampleMs).toBe(0);
  });

  it("retains signed deltas, redacted JS ancestry and native labels from raw V8", () => {
    const value = profile();
    value.nodes[7]!.callFrame.functionName = "nativeMethod";
    Object.assign(value.nodes[6]!.callFrame, {
      functionName: "[redacted]",
      url: "",
      scriptId: "2",
    });
    value.samples = [8, 9, 1];
    value.timeDeltas = [100_000, -10_000, 200_000];
    expect(attributeNativeCpuSamples(value)).toMatchObject({
      nativeMs: 90,
      nativePercent: 9,
      parents: [{ parent: "[redacted] [redacted]:10:1", nativeMs: 90 }],
    });
  });

  it("reports native samples without JS ancestry and rejects missing timing or nodes", () => {
    const value = profile();
    value.nodes[0]!.children!.push(10);
    value.nodes.push({ ...value.nodes[8]!, id: 10 });
    value.samples = [10];
    value.timeDeltas = [100_000];
    expect(attributeNativeCpuSamples(value).parents[0]?.parent).toBe("(unattributed)");
    value.samples = [99];
    expect(() => attributeNativeCpuSamples(value)).toThrow("Unknown CPU profile sample node");
    value.timeDeltas = [];
    expect(() => attributeNativeCpuSamples(value)).toThrow("matching samples and timeDeltas");
  });
});
