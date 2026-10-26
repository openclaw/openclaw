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
  summarizeScriptCoverage,
  summarizeJavaScriptResources,
  summarizeCpuProfile,
  type ColdLoadCpuProfile,
  type ColdLoadTraceEvent,
} from "../../scripts/lib/control-ui-cold-load-trace.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const assetBaseUrl = "http://localhost/assets/";
const frame = (functionName: string, url = "app.ts", lineNumber = 0, columnNumber = 0) => ({
  functionName,
  url,
  lineNumber,
  columnNumber,
});
const node = (id: number, callFrame: ReturnType<typeof frame>, children?: number[]) => ({
  id,
  callFrame,
  ...(children ? { children } : {}),
});
const singleProfile = (name: string, url: string, delta = 1_000): ColdLoadCpuProfile => ({
  nodes: [node(1, frame(name, url))],
  samples: [1],
  timeDeltas: [delta],
});
const mapProfile = (profile: ColdLoadCpuProfile, assetDirectory: string) =>
  mapColdLoadCpuProfile(profile, { assetBaseUrl, assetDirectory });
const sourceLocation = (url: RegExp, lineNumber = 0, columnNumber = 0) => ({
  url: expect.stringMatching(url),
  lineNumber,
  columnNumber,
});
async function writeMap(directory: string, file: string, map: object) {
  await writeFile(path.join(directory, `${file}.js.map`), JSON.stringify({ version: 3, ...map }));
}

function event(
  name: string,
  ph: string,
  ts: number,
  extra: Partial<ColdLoadTraceEvent> = {},
): ColdLoadTraceEvent {
  return { name, ph, ts, pid: 7, tid: 1, ...extra };
}

describe("cold-load trace accounting", () => {
  it("counts fetched JavaScript independently of observed V8 scripts", () => {
    const resources = [
      {
        url: "http://localhost/assets/entry.js",
        decodedBytes: 100,
        encodedBytes: 30,
        transferBytes: 330,
      },
      {
        url: "http://localhost/assets/preload.js?v=1",
        decodedBytes: 200,
        encodedBytes: 40,
        transferBytes: 340,
      },
      {
        url: "http://localhost/assets/style.css",
        decodedBytes: 50,
        encodedBytes: 20,
        transferBytes: 320,
      },
    ];
    expect(summarizeJavaScriptResources(resources, [{ url: resources[0]!.url }])).toEqual({
      requests: 2,
      rawBytes: 300,
      encodedBytes: 70,
      transferBytes: 670,
      outsideCoverage: { requests: 1, rawBytes: 200, encodedBytes: 40, transferBytes: 340 },
    });
    expect(summarizeJavaScriptResources(resources).outsideCoverage).toBeUndefined();
  });

  it("counts UTF-8 coverage with nested unexecuted blocks and invoked inner functions", () => {
    expect(
      summarizeScriptCoverage({
        source: "abcé😀xyz",
        functions: [
          { ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] },
          {
            ranges: [
              { startOffset: 3, endOffset: 9, count: 0 },
              { startOffset: 4, endOffset: 6, count: 1 },
            ],
          },
        ],
      }),
    ).toEqual({ loadedBytes: 12, executedBytes: 7, unusedBytes: 5 });
  });

  it("prepares numeric CDP envelopes, including unnamed end events", () => {
    expect(
      prepareColdLoadTraceEvent(
        event("Layout", "B", 10, {
          args: { beginData: { stackTrace: [{ functionName: "measure" }] } },
        }),
      ),
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
      longTaskIntervals: [
        { startUs: 1_000_000, endUs: 1_070_000, durationMs: 70 },
        { startUs: 1_040_000, endUs: 1_130_000, durationMs: 90 },
        { startUs: 1_150_000, endUs: 1_200_000, durationMs: 50 },
      ],
      longestTaskMs: 90,
      layoutCount: 2,
      layoutMs: 30,
      forcedLayouts: 1,
      forcedLayoutMs: 10,
      compilation: {
        mainThread: { events: 0, wallMs: 0, threadCpuMs: null },
        allRendererThreads: { events: 0, wallMs: 0, threadCpuMs: null },
        eventNames: [],
      },
    });
  });

  it("unions nested compiler work per renderer thread and preserves thread CPU clocks", () => {
    const trace = [
      event("navigationStart", "I", 1_000),
      event("RunTask", "X", 1_000, { dur: 20_000 }),
      event("V8.CompileCode", "X", 2_000, { dur: 8_000, tts: 100, tdur: 4_000 }),
      event("V8.ParseFunction", "X", 3_000, { dur: 1_000, tts: 1_000, tdur: 800 }),
      event("v8.compileModule", "B", 12_000, { tts: 9_000 }),
      event("v8.compileModule", "E", 14_000, { tts: 9_500 }),
      event("v8.parseOnBackground", "X", 3_000, { tid: 2, dur: 12_000, tts: 500, tdur: 6_000 }),
      event("V8.CompileCode", "X", 3_000, { pid: 9, dur: 15_000, tts: 0, tdur: 15_000 }),
      event("V8.JsonParse", "X", 16_000, { dur: 1_000 }),
      event("V8.CompileCodeWait", "X", 16_000, { dur: 1_000 }),
    ].map(prepareColdLoadTraceEvent);
    expect(summarizeColdLoadTrace(trace, 20).compilation).toEqual({
      mainThread: { events: 3, wallMs: 10, threadCpuMs: 4.5 },
      allRendererThreads: { events: 4, wallMs: 22, threadCpuMs: 10.5 },
      eventNames: [
        { name: "v8.compileModule", count: 1 },
        { name: "V8.CompileCode", count: 1 },
        { name: "V8.ParseFunction", count: 1 },
        { name: "v8.parseOnBackground", count: 1 },
      ].toSorted((left, right) => left.name.localeCompare(right.name)),
    });
  });

  it("does not substitute wall time for missing or clipped compilation CPU", () => {
    const trace = [
      event("navigationStart", "I", 1_000),
      event("RunTask", "X", 1_000, { dur: 20_000 }),
      event("V8.CompileCode", "X", 2_000, { dur: 1_000 }),
      event("v8.parseOnBackground", "X", 20_000, { tid: 2, dur: 5_000, tts: 500, tdur: 4_000 }),
    ];
    expect(summarizeColdLoadTrace(trace, 20).compilation).toMatchObject({
      mainThread: { events: 1, wallMs: 1, threadCpuMs: null },
      allRendererThreads: { events: 2, wallMs: 2, threadCpuMs: null },
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
  it("weights leaf samples by time delta and counts nested Solid flush time once", () => {
    const solidUrl = "node_modules/@solidjs/signals/dist/prod.js";
    const profile: ColdLoadCpuProfile = {
      nodes: [
        node(1, frame("(root)"), [2, 5]),
        node(2, frame("flush", solidUrl), [3]),
        node(3, frame("renderRows"), [4]),
        node(4, frame("flush", solidUrl, 10)),
        node(5, frame("(idle)")),
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
      await writeMap(directory, "app", {
        sources: ["node_modules/@solidjs/signals/dist/prod.js"],
        names: ["flush"],
        mappings: "AAAAA",
      });
      const profile = singleProfile("a", `http://localhost${assetPath}`, 2_000);

      const mapped = await mapProfile(profile, directory);
      expect(mapped).toMatchObject({ mappedFrames: 1, unmappedFrames: 0 });
      expect(mapped.profile.nodes[0]?.callFrame).toMatchObject({
        functionName: "flush",
        ...sourceLocation(/node_modules\/@solidjs\/signals\/dist\/prod\.js$/u),
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
    const mapped = await mapProfile(
      {
        nodes: [
          node(1, frame("t", `${assetBaseUrl}app.js`, 0, generatedColumn)),
          node(2, frame("t", `${assetBaseUrl}app.js`, 0, 1)),
          node(3, frame("runtime", `${assetBaseUrl}app.js`, 2)),
        ],
      },
      directory,
    );
    for (const [index, line, column] of [
      [0, 1, 9],
      [1, 0, 7],
    ] as const) {
      expect(mapped.profile.nodes[index]?.callFrame).toMatchObject(
        sourceLocation(/(?:^|\/)src\/timestamp\.ts$/u, line, column),
      );
    }
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
    const profile = singleProfile("sample", `${assetBaseUrl}app.js`);
    async function capture(assetDirectory: string) {
      await build({
        entryPoints: [source],
        outfile: path.join(assetDirectory, "app.js"),
        format: "esm",
        minify: true,
        sourcemap: "external",
      });
      const mapped = await mapProfile(profile, assetDirectory);
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
        node(1, frame("(root)", ""), [2]),
        node(2, outer, [3]),
        node(3, inner, [4]),
        node(4, frame("render", "view.ts")),
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

  it("rejects comparisons with different phase sets", () => {
    const phase = "live";
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
      await writeMap(directory, "runtime", {
        sources: ["app.ts"],
        names: [],
        mappings: "A,KAAA",
      });
    }
    const profile = singleProfile("runtime", `${assetBaseUrl}runtime.js`);
    const mapped = await mapProfile(profile, directory);
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
