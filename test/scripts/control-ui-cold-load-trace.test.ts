import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeColdLoadTrace,
  summarizeCpuProfile,
  type ColdLoadCpuProfile,
  type ColdLoadTraceEvent,
} from "../../scripts/lib/control-ui-cold-load-trace.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function event(
  name: string,
  ph: string,
  ts: number,
  extra: Partial<ColdLoadTraceEvent> = {},
): ColdLoadTraceEvent {
  return { name, ph, ts, pid: 7, tid: 1, ...extra };
}

describe("cold-load trace accounting", () => {
  it("prepares numeric CDP envelopes, including unnamed end events", () => {
    expect(
      prepareColdLoadTraceEvent({
        name: "Layout",
        ph: "B",
        ts: 10,
        pid: 7,
        tid: 1,
        args: { beginData: { stackTrace: [{ functionName: "measure" }] } },
      }),
    ).toMatchObject({ name: "Layout", args: { beginData: { stackTrace: [{}] } } });
    expect(prepareColdLoadTraceEvent({ ph: "E", ts: 20, pid: 7, tid: 1 })).toMatchObject({
      ph: "E",
      ts: 20,
    });
    expect(() =>
      prepareColdLoadTraceEvent({ name: "Layout", ph: "X", ts: "10", pid: 7, tid: 1 }),
    ).toThrow("Invalid Chrome trace event envelope");
  });

  it("unions overlapping main-thread tasks inside the navigation window", () => {
    const trace = [
      event("thread_name", "M", 0, { args: { name: "CrRendererMain" } }),
      event("thread_name", "M", 0, { pid: 9, args: { name: "CrRendererMain" } }),
      event("navigationStart", "I", 1_000_000),
      event("RunTask", "X", 980_000, { dur: 90_000 }),
      event("RunTask", "X", 1_000_000, { pid: 9, dur: 500_000 }),
      event("RunTask", "X", 1_000_000, { tid: 2, dur: 500_000 }),
      event("Layout", "X", 1_010_000, {
        dur: 10_000,
        args: { beginData: { stackTrace: [{ functionName: "measure" }] } },
      }),
      event("RunTask", "X", 1_040_000, { dur: 90_000 }),
      event("ThreadControllerImpl::RunTask", "X", 1_040_000, { dur: 90_000 }),
      event("Layout", "B", 1_080_000),
      event("Layout", "E", 1_100_000),
      event("RunTask", "B", 1_150_000),
      event("RunTask", "E", 1_250_000),
    ];

    expect(summarizeColdLoadTrace(trace, 200)).toEqual({
      durationMs: 200,
      navigationStartUs: 1_000_000,
      navigationStartFound: true,
      rendererPid: 7,
      rendererTid: 1,
      busyMs: 180,
      longTasks: 3,
      longTaskMs: 180,
      longestTaskMs: 90,
      layoutCount: 2,
      layoutMs: 30,
      forcedLayouts: 1,
      forcedLayoutMs: 10,
    });
  });

  it("marks a missing navigation marker rather than presenting fallback time as navigation", () => {
    expect(summarizeColdLoadTrace([event("RunTask", "X", 10, { dur: 5_000 })], 20)).toMatchObject({
      navigationStartUs: 10,
      navigationStartFound: false,
      busyMs: 5,
    });
    expect(() => summarizeColdLoadTrace([], 20)).toThrow("no renderer main-thread tasks");
  });
});

describe("cold-load CPU accounting", () => {
  const frame = (functionName: string, url = "app.ts", lineNumber = 0) => ({
    functionName,
    url,
    lineNumber,
    columnNumber: 0,
  });

  it("weights leaf samples by time delta and counts nested Solid flush time once", () => {
    const solidUrl = "node_modules/@solidjs/signals/dist/prod.js";
    const profile: ColdLoadCpuProfile = {
      nodes: [
        { id: 1, callFrame: frame("(root)"), children: [2, 5] },
        { id: 2, callFrame: frame("flush", solidUrl), children: [3] },
        { id: 3, callFrame: frame("renderRows"), children: [4] },
        { id: 4, callFrame: frame("flush", solidUrl, 10) },
        { id: 5, callFrame: frame("(idle)") },
      ],
      samples: [2, 3, 4, 5, 3],
      timeDeltas: [1_000, 2_000, 3_000, 4_000, 5_000],
    };

    const summary = summarizeCpuProfile(profile);
    expect(summary).toMatchObject({
      sampledMs: 15,
      idleMs: 4,
      solidFlushSelfMs: 4,
      solidFlushInclusiveMs: 11,
    });
    expect(summary.hotspots[0]).toMatchObject({
      functionName: "renderRows",
      selfMs: 7,
      samples: 2,
    });
    expect(summary.hotspots.map((hotspot) => hotspot.functionName)).not.toContain("(idle)");
  });

  it.each(["/assets/app.js", "/dashboard/main/review/assets/app.js"])(
    "maps generated call sites at %s",
    async (assetPath) => {
      const directory = tempDirs.make("openclaw-cold-load-map-");
      await writeFile(
        path.join(directory, "app.js.map"),
        JSON.stringify({
          version: 3,
          file: "app.js",
          sources: ["node_modules/@solidjs/signals/dist/prod.js"],
          sourcesContent: ["function flush() {}"],
          sourceRoot: "",
          names: ["flush"],
          mappings: "AAAAA",
        }),
      );
      const profile: ColdLoadCpuProfile = {
        nodes: [{ id: 1, callFrame: frame("a", `http://localhost${assetPath}`) }],
        samples: [1],
        timeDeltas: [2_000],
      };

      const mapped = await mapColdLoadCpuProfile(profile, {
        assetBaseUrl: "http://localhost/assets/",
        assetDirectory: directory,
      });
      expect(mapped).toMatchObject({ mappedFrames: 1, unmappedFrames: 0 });
      expect(mapped.profile.nodes[0]?.callFrame).toMatchObject({
        functionName: "flush",
        url: expect.stringMatching(/node_modules\/@solidjs\/signals\/dist\/prod\.js$/u),
        lineNumber: 0,
        columnNumber: 0,
      });
      expect(summarizeCpuProfile(mapped.profile)).toMatchObject({
        solidFlushSelfMs: 2,
        solidFlushInclusiveMs: 2,
      });
      expect(profile.nodes[0]?.callFrame.functionName).toBe("a");
    },
  );

  it("retains an unmapped bundler runtime without inventing its source", async () => {
    const profile: ColdLoadCpuProfile = {
      nodes: [{ id: 1, callFrame: frame("runtime", "http://localhost/assets/runtime.js") }],
      samples: [1],
      timeDeltas: [1000],
    };
    const mapped = await mapColdLoadCpuProfile(profile, {
      assetBaseUrl: "http://localhost/assets/",
      assetDirectory: tempDirs.make("openclaw-cold-load-unmapped-"),
    });
    expect(mapped).toMatchObject({ mappedFrames: 0, unmappedFrames: 1 });
    expect(mapped.profile.nodes[0]).toBe(profile.nodes[0]);
  });

  it("uses timestamps when Chrome emits samples out of order", () => {
    const summary = summarizeCpuProfile({
      nodes: [1, 2, 3].map((id) => ({ id, callFrame: frame(`work${id}`) })),
      samples: [1, 3, 2],
      timeDeltas: [2000, 2000, -1000],
    });
    expect(summary).toMatchObject({ sampledMs: 4, outOfOrderSamples: 1 });
    expect(summary.hotspots.map(({ functionName, selfMs }) => [functionName, selfMs])).toEqual([
      ["work1", 2],
      ["work2", 1],
      ["work3", 1],
    ]);
  });

  it("rejects missing sample timing instead of inventing a sampling interval", () => {
    expect(() => summarizeCpuProfile({ nodes: [], samples: [1] })).toThrow(
      "matching samples and time deltas",
    );
  });
});
