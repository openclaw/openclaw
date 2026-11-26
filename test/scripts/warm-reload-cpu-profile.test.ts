import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CDPSession } from "playwright";
import { afterEach, expect, it } from "vitest";
import {
  captureWarmReloadColdCpu,
  summarizeWarmReloadCpu,
} from "../../scripts/perf/warm-reload-cpu-profile.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const exec = promisify(execFile);
const profile = {
  startTime: 9_900_000,
  endTime: 18_100_000,
  nodes: ["before", "after", "inside"].map((functionName, index) => ({
    id: index + 1,
    callFrame: {
      functionName,
      url: "http://localhost/assets/missing.js",
      lineNumber: 0,
      columnNumber: 0,
    },
  })),
  samples: [1, 2, 3],
  timeDeltas: [120_000, 20_000, -10_000],
};
const metrics = (at: number, work: number) => [
  { name: "NavigationStart", value: 10 },
  { name: "Timestamp", value: 10 + at / 1_000 },
  ...[
    "ThreadTime",
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "V8CompileDuration",
    "DevToolsCommandDuration",
    "TaskOtherDuration",
  ].map((name) => ({ name, value: work })),
  { name: "LayoutCount", value: work * 1_000 },
  { name: "RecalcStyleCount", value: work * 1_000 },
];
const finalMetrics = metrics(8_100, 0.04);
const snapshots = [
  { title: "warm-reload-cpu:hello-handled", metrics: metrics(20, 0.01) },
  { title: "warm-reload-cpu:rows-observed", metrics: metrics(65, 0.02) },
];
const probe = {
  helloHandledMs: 20,
  firstPaintedRowsMs: 40,
  capturedUntilMs: 8_000,
  cpuAttribution: {
    supported: true,
    overflow: false,
    droppedEntries: null,
    rowObservedAtMs: 65,
    loaf: [{ startTime: 20, duration: 60, scripts: [{ invoker: "Promise.then" }] }],
  },
};

it.each([
  [["--reloads", "1"], "requires --reloads 0"],
  [["--reloads", "0", "--prime-reloads", "1"], "requires --reloads 0 --prime-reloads 0"],
  [["--reloads", "0", "--visual-proofs"], "cannot be combined"],
  [["--reloads", "0", "--cpu-profile"], "cannot be combined"],
  [["--reloads", "0"], "requires --route chat"],
  [["--reloads", "0", "--route", "dashboard"], "requires --route chat"],
] as const)(
  "rejects incompatible cold capture arguments %j before build or browser admission",
  async (args, message) => {
    await expect(
      exec(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "scripts/perf/warm-reload-proof.ts",
          "--cold-cpu-profile",
          ...args,
        ],
        { timeout: 10_000, maxBuffer: 64 * 1024 },
      ),
    ).rejects.toThrow(message);
  },
);

function transport(failedMethod?: string) {
  const events = new EventEmitter();
  const calls: string[] = [];
  const cdp = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    async send(method: string) {
      calls.push(method);
      if (method === failedMethod) {
        throw new Error(`${method} failed`);
      }
      switch (method) {
        case "Profiler.stop":
          return { profile };
        case "Performance.getMetrics":
          return { metrics: finalMetrics };
        case "Performance.enable":
        case "Performance.disable":
        case "Profiler.enable":
        case "Profiler.setSamplingInterval":
        case "Profiler.start":
        case "Profiler.disable":
          return {};
        default:
          throw new Error(`Unexpected capture instrumentation: ${method}`);
      }
    },
  } as unknown as CDPSession;
  const outputDir = tempDirs.make("warm-reload-cpu-");
  return {
    cdp,
    calls,
    events,
    options: { outputDir, assetBaseUrl: "http://localhost/assets/", assetDirectory: outputDir },
    capture: async () => {
      for (const snapshot of snapshots) {
        events.emit("Performance.metrics", snapshot);
      }
      return probe;
    },
  };
}

it("aligns signed samples to navigation while keeping delayed counter delivery separate", () => {
  const result = summarizeWarmReloadCpu(profile, probe, snapshots, finalMetrics);
  expect(result.coverage).toMatchObject({
    fullNavigationCovered: true,
    unprofiledNavigationPrefixMs: 0,
  });
  expect(result.helloToRowPaint).toMatchObject({ startMs: 20, endMs: 40, sampledMs: 20 });
  expect(result.helloToRowPaint.tables?.functions).toEqual([
    expect.objectContaining({ functionName: "inside", selfMs: 10 }),
    expect.objectContaining({ functionName: "after", selfMs: 10 }),
  ]);
  expect(result.counters.rowObserverDelayMs).toBe(25);
  expect(result.counters.durationsMs.ThreadTime).toBeCloseTo(10);
  expect(result.counters.startMs).toBeCloseTo(20);
  expect(result.counters.endMs).toBeCloseTo(65);
  expect(profile.timeDeltas).toEqual([120_000, 20_000, -10_000]);
  expect(() => summarizeWarmReloadCpu(profile, probe, [snapshots[0]!], finalMetrics)).toThrow(
    "needs one",
  );
  expect(() =>
    summarizeWarmReloadCpu(profile, probe, [...snapshots, snapshots[0]!], finalMetrics),
  ).toThrow("needs one");
  expect(() =>
    summarizeWarmReloadCpu(
      profile,
      probe,
      [snapshots[0]!, { ...snapshots[1]!, metrics: metrics(65, 0) }],
      finalMetrics,
    ),
  ).toThrow("counter reset");
  expect(() =>
    summarizeWarmReloadCpu(
      profile,
      probe,
      [snapshots[0]!, { ...snapshots[1]!, metrics: [{ name: "NavigationStart", value: 11 }] }],
      finalMetrics,
    ),
  ).toThrow("one navigation");
  expect(() =>
    summarizeWarmReloadCpu({ ...profile, startTime: 10_030_000 }, probe, snapshots, finalMetrics),
  ).toThrow("does not cover");
  expect(() =>
    summarizeWarmReloadCpu({ ...profile, endTime: 10_100_000 }, probe, snapshots, finalMetrics),
  ).toThrow("recorded capture end");
  expect(() =>
    summarizeWarmReloadCpu(profile, probe, snapshots, [{ name: "NavigationStart", value: 11 }]),
  ).toThrow("one navigation");
  expect(() =>
    summarizeWarmReloadCpu({ ...profile, samples: [] }, probe, snapshots, finalMetrics),
  ).toThrow("matching samples");
});

it("records an unprofiled navigation prefix without omitting post-hello work", () => {
  const restarted = { ...profile, startTime: 10_010_000, timeDeltas: [10_000, 20_000, -10_000] };
  const result = summarizeWarmReloadCpu(restarted, probe, snapshots, finalMetrics);
  expect(result.coverage).toEqual({
    scope: "Hello handled through recorded capture end",
    recordingStartMs: 10,
    recordingEndMs: 8_100,
    firstSampleMs: 20,
    lastSampleMs: 40,
    requiredStartMs: 20,
    requiredEndMs: 8_000,
    unprofiledNavigationPrefixMs: 10,
    fullNavigationCovered: false,
  });
  expect(result.helloToRowPaint.sampledMs).toBe(20);
  expect(restarted.timeDeltas).toEqual([10_000, 20_000, -10_000]);
  expect(() => summarizeWarmReloadCpu(restarted, probe, snapshots, metrics(7_999, 0.04))).toThrow(
    "recorded capture end",
  );
});

it("retains all raw samples and unmapped frames without visual or tracing commands", async () => {
  const owner = transport();
  const result = await captureWarmReloadColdCpu(owner.cdp, owner.options, owner.capture);
  expect(result.attribution.mappingCoverage).toBe("unknown");
  const read = async (name: string) =>
    JSON.parse(await readFile(path.join(owner.options.outputDir, name), "utf8"));
  expect(await read("cold.cpuprofile")).toEqual(profile);
  expect(await read("cold.mapped.cpuprofile")).toEqual(profile);
  expect(await read("cold-cpu-clocks.json")).toMatchObject({ snapshots, probe });
  expect(owner.events.listenerCount("Performance.metrics")).toBe(0);
  expect(owner.calls.slice(-4)).toEqual([
    "Profiler.stop",
    "Performance.getMetrics",
    "Profiler.disable",
    "Performance.disable",
  ]);
});

it("settles both CDP domains after capture and stop failures without losing the original error", async () => {
  const owner = transport("Profiler.stop");
  const failure = new Error("navigation failed");
  await expect(
    captureWarmReloadColdCpu(owner.cdp, owner.options, async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({ errors: [failure, new Error("Profiler.stop failed")] });
  expect(owner.calls.slice(-4)).toEqual([
    "Profiler.stop",
    "Performance.getMetrics",
    "Profiler.disable",
    "Performance.disable",
  ]);
  expect(owner.events.listenerCount("Performance.metrics")).toBe(0);
});

it("disables requested domains even when profiler enable rejects", async () => {
  const owner = transport("Profiler.enable");
  await expect(
    captureWarmReloadColdCpu(owner.cdp, owner.options, owner.capture),
  ).rejects.toMatchObject({ errors: [new Error("Profiler.enable failed")] });
  expect(owner.calls).not.toContain("Profiler.start");
  expect(owner.calls.slice(-2)).toEqual(["Profiler.disable", "Performance.disable"]);
  expect(owner.events.listenerCount("Performance.metrics")).toBe(0);
});

it.each(["overflow", "dropped", "unsupported", "duplicate marker"])(
  "refuses incomplete %s attribution after cleanup",
  async (kind) => {
    const owner = transport();
    await expect(
      captureWarmReloadColdCpu(owner.cdp, owner.options, async () => {
        await owner.capture();
        if (kind === "duplicate marker") {
          owner.events.emit("Performance.metrics", snapshots[0]);
        }
        return {
          ...probe,
          cpuAttribution: {
            ...probe.cpuAttribution,
            overflow: kind === "overflow",
            supported: kind !== "unsupported",
            droppedEntries: kind === "dropped" ? 1 : 0,
          },
        };
      }),
    ).rejects.toThrow("incomplete");
    expect(owner.events.listenerCount("Performance.metrics")).toBe(0);
    expect(
      JSON.parse(await readFile(path.join(owner.options.outputDir, "cold.cpuprofile"), "utf8")),
    ).toEqual(profile);
  },
);
