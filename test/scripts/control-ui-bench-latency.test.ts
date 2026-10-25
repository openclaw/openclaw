import { expect, it } from "vitest";
import { resolveColdLoadLatency } from "../../scripts/lib/control-ui-bench-latency.ts";

it("keeps explicit delivery overrides independent of profile selection", () => {
  const input = {
    profile: "live-fast",
    latencyMs: "7",
    frameGapMs: "2",
    connectNotBeforeMs: "100",
    methodLatencyMs: ["connect=15", "board.get=60", "connect=17"],
    sidebarQueryLatencyMs: ["ownerFirst=90"],
  };
  const resolved = resolveColdLoadLatency(input);
  expect(resolved).toMatchObject({
    latencyProfile: "live-fast",
    latencyMs: 7,
    frameGapMs: 2,
    connectNotBeforeMs: 100,
    methodLatencyMs: { connect: 17, "board.get": 60, "chat.startup": 220 },
    sidebarQueryLatencyMs: { ownerFirst: 90 },
  });
  // One run's overrides must not mutate the preset used by a later run.
  expect(resolveColdLoadLatency({ ...input, methodLatencyMs: [] }).methodLatencyMs.connect).toBe(
    41,
  );
});

it("rejects unknown profiles and malformed overrides before launching a browser", () => {
  const input = { methodLatencyMs: [], sidebarQueryLatencyMs: [] };
  expect(() => resolveColdLoadLatency({ ...input, profile: "typo" })).toThrow("latency-profile");
  for (const entry of ["connect", "connect=-1", "connect=NaN", "connect=1=2"]) {
    expect(() => resolveColdLoadLatency({ ...input, methodLatencyMs: [entry] })).toThrow(
      "method-latency-ms",
    );
  }
});
