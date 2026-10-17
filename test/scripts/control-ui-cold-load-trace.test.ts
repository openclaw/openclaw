import { writeFile } from "node:fs/promises";
import path from "node:path";
import { build, transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCpuTables,
  formatCpuTables,
  medianCpuTables,
  readCpuProfileReport,
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

  it("maps a real emitted minified map using zero-based generated positions", async () => {
    const directory = tempDirs.make("openclaw-cold-load-emitted-map-");
    const { code, map } = await transform(
      "export function prepareTimestamp(value: number) {\n  return value + 1;\n}\n",
      {
        loader: "ts",
        sourcefile: "../../src/timestamp.ts",
        sourcemap: "external",
        minify: true,
        footer: "\nfunction runtime() {}",
      },
    );
    await writeFile(path.join(directory, "app.js.map"), map);
    const generatedColumn = code.indexOf("+1");
    expect(generatedColumn).toBeGreaterThan(0);
    const mapped = await mapColdLoadCpuProfile(
      {
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: "t",
              url: "http://localhost/assets/app.js",
              lineNumber: 0,
              columnNumber: generatedColumn,
            },
          },
          {
            id: 2,
            callFrame: {
              functionName: "t",
              url: "http://localhost/assets/app.js",
              lineNumber: 0,
              columnNumber: 1,
            },
          },
          {
            id: 3,
            callFrame: frame("runtime", "http://localhost/assets/app.js", 2),
          },
        ],
      },
      { assetBaseUrl: "http://localhost/assets/", assetDirectory: directory },
    );
    expect(mapped.profile.nodes[0]?.callFrame).toMatchObject({
      url: expect.stringMatching(/(?:^|\/)src\/timestamp\.ts$/u),
      lineNumber: 1,
      columnNumber: 9,
    });
    expect(mapped.profile.nodes[1]?.callFrame).toMatchObject({
      url: expect.stringMatching(/(?:^|\/)src\/timestamp\.ts$/u),
      lineNumber: 0,
      columnNumber: 7,
    });
    expect(code.split("\n")[2]).toBe("function runtime() {}");
    expect(mapped).toMatchObject({ mappedFrames: 2, unmappedFrames: 1 });
    expect(mapped.profile.nodes[2]?.callFrame).toEqual(
      frame("runtime", "http://localhost/assets/app.js", 2),
    );
  });

  it("compares the same emitted function across output directories", async () => {
    const directory = tempDirs.make("openclaw-cold-load-output-paths-");
    const source = path.join(directory, "source.ts");
    await writeFile(source, "export function sample(value: number) { return value + 1; }");
    const profile: ColdLoadCpuProfile = {
      nodes: [{ id: 1, callFrame: frame("sample", "http://localhost/assets/app.js") }],
      samples: [1],
      timeDeltas: [1_000],
    };
    async function capture(assetDirectory: string) {
      await build({
        entryPoints: [source],
        outfile: path.join(assetDirectory, "app.js"),
        format: "esm",
        minify: true,
        sourcemap: "external",
      });
      const mapped = await mapColdLoadCpuProfile(profile, {
        assetBaseUrl: "http://localhost/assets/",
        assetDirectory,
      });
      expect(mapped.mappedFrames).toBe(1);
      return summarizeCpuProfile(mapped.profile, { includeTables: true }).tables!;
    }
    const baseline = await capture(path.join(directory, "one"));
    const candidate = await capture(path.join(directory, "nested", "two"));
    expect(compareCpuTables(baseline, candidate)).toEqual([
      expect.objectContaining({ selfMs: 0, inclusiveMs: 0 }),
    ]);
  });

  it("counts recursive functions and same-file ancestors once per inclusive sample", () => {
    const outer = { ...frame("reconcile"), scriptId: "1" };
    const inner = { ...frame("reconcile"), scriptId: "2" };
    const profile: ColdLoadCpuProfile = {
      nodes: [
        { id: 1, callFrame: frame("(root)", ""), children: [2] },
        { id: 2, callFrame: outer, children: [3] },
        { id: 3, callFrame: inner, children: [4] },
        { id: 4, callFrame: frame("render", "view.ts") },
      ],
      samples: [3, 4],
      timeDeltas: [2000, 3000],
    };
    const tables = summarizeCpuProfile(profile, { includeTables: true }).tables!;
    expect(tables.functions).toEqual([
      { ...frame("reconcile"), selfMs: 2, inclusiveMs: 5 },
      { ...frame("render", "view.ts"), selfMs: 3, inclusiveMs: 3 },
    ]);
    expect(tables.files).toEqual([
      { url: "app.ts", inclusiveMs: 5 },
      { url: "view.ts", inclusiveMs: 3 },
    ]);
    const median = medianCpuTables([tables, { functions: [], files: [] }]);
    expect(median.functions[0]).toMatchObject({ selfMs: 1, inclusiveMs: 2.5 });
    expect(median.files[0]?.inclusiveMs).toBe(2.5);
    expect(compareCpuTables(tables, median)[0]).toMatchObject({
      baselineSelfMs: 2,
      selfMs: -1,
      inclusiveMs: -2.5,
    });
    expect(compareCpuTables(median, { functions: [], files: [] })[0]).toMatchObject({
      selfMs: -1,
      inclusiveMs: -2.5,
    });
    expect(formatCpuTables("Median", median)).toContain("app.ts:1:1 reconcile");
    expect(readCpuProfileReport({ reload: median }, ["reload"])).toEqual({ reload: median });
    expect(() =>
      readCpuProfileReport({ reload: { functions: [{ selfMs: "2" }], files: [] } }, ["reload"]),
    ).toThrow();
  });

  it.each(["live", "streaming"])("rejects comparisons that omit the %s phase", (phase) => {
    const tables = { functions: [], files: [] };
    const report = { reload: tables, [phase]: tables };
    expect(() => readCpuProfileReport(report, ["reload"])).toThrow("CPU profile phases differ");
    expect(() => readCpuProfileReport({ reload: tables }, ["reload", phase])).toThrow(
      "CPU profile phases differ",
    );
    expect(readCpuProfileReport(report, [phase, "reload"])).toEqual(report);
  });

  it.each(["missing map", "unmapped segment"])("retains a frame with %s", async (kind) => {
    const directory = tempDirs.make("openclaw-cold-load-unmapped-");
    if (kind === "unmapped segment") {
      await writeFile(
        path.join(directory, "runtime.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["app.ts"],
          names: [],
          mappings: "A,KAAA",
        }),
      );
    }
    const profile: ColdLoadCpuProfile = {
      nodes: [{ id: 1, callFrame: frame("runtime", "http://localhost/assets/runtime.js") }],
      samples: [1],
      timeDeltas: [1000],
    };
    const mapped = await mapColdLoadCpuProfile(profile, {
      assetBaseUrl: "http://localhost/assets/",
      assetDirectory: directory,
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
