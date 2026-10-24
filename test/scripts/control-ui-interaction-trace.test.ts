import { expect, it } from "vitest";
import type {
  ColdLoadCpuProfile,
  ColdLoadTraceEvent,
} from "../../scripts/lib/control-ui-cold-load-trace.ts";
import {
  clipInteractionCpuProfile,
  summarizeInteractionSelectors,
  summarizeInteractionTrace,
  summarizeLongTaskCpuProfiles,
} from "../../scripts/lib/control-ui-interaction-trace.ts";

it("measures only the marked renderer interval, unions nesting, and rejects missing boundaries", () => {
  const event = (
    name: string,
    ph: string,
    ts: number,
    extra: Partial<ColdLoadTraceEvent> = {},
  ): ColdLoadTraceEvent => ({ name, ph, ts, pid: 7, tid: 1, ...extra });
  const marks = { start: "filter:start", end: "filter:end" };
  const trace = [
    event("thread_name", "M", 0, { args: { name: "CrRendererMain" } }),
    event("RunTask", "X", 90_000, { dur: 90_000 }),
    event(marks.start, "I", 100_000),
    event("RunTask", "X", 100_000, { pid: 9, dur: 300_000 }),
    event("ThreadControllerImpl::RunTask", "X", 100_000, { dur: 70_000 }),
    event("FunctionCall", "B", 90_000),
    event("RunMicrotasks", "X", 110_000, { dur: 30_000 }),
    event("UpdateLayoutTree", "X", 120_000, { dur: 20_000 }),
    event("RecalculateStyles", "X", 125_000, { dur: 5_000 }),
    event("Layout", "B", 140_000, {
      args: { beginData: { stackTrace: [{ functionName: "measure" }] } },
    }),
    event("Layout", "X", 145_000, { dur: 5_000 }),
    { ph: "E", ts: 160_000, pid: 7, tid: 1 },
    { ph: "E", ts: 170_000, pid: 7, tid: 1 },
    event("RunTask", "B", 190_000),
    event("EvaluateScript", "X", 195_000, { dur: 30_000 }),
    event(marks.end, "I", 200_000),
    { ph: "E", ts: 220_000, pid: 7, tid: 1 },
    event("RunTask", "X", 230_000, { dur: 300_000 }),
  ];

  expect(summarizeInteractionTrace(trace, marks)).toEqual({
    startUs: 100_000,
    endUs: 200_000,
    durationMs: 100,
    rendererPid: 7,
    rendererTid: 1,
    taskCount: 2,
    busyMs: 90,
    longTasks: 1,
    longTaskMs: 80,
    longTaskIntervals: [{ startUs: 100_000, endUs: 180_000, durationMs: 80 }],
    longestTaskMs: 80,
    scriptCount: 3,
    scriptMs: 75,
    layoutCount: 2,
    layoutMs: 20,
    styleCount: 2,
    styleMs: 20,
    forcedLayouts: 1,
    forcedLayoutMs: 20,
  });
  expect(() => summarizeInteractionTrace(trace, { ...marks, end: "missing" })).toThrow(
    "exactly one mark: missing",
  );
  expect(() =>
    summarizeInteractionTrace([...trace, event(marks.start, "I", 105_000)], marks),
  ).toThrow("exactly one mark: filter:start");
});

it("attributes separate long tasks to their nearest mapped application callers", () => {
  const node = (
    id: number,
    functionName: string,
    url = "",
    children: number[] = [],
    lineNumber = -1,
    columnNumber = -1,
  ): ColdLoadCpuProfile["nodes"][number] => ({
    id,
    callFrame: { functionName, url, lineNumber, columnNumber },
    children,
  });
  const transcript = "ui/src/components/chat/message-list.tsx";
  const settings = "ui/src/pages/settings/settings-page.tsx";
  const solid = "node_modules/solid-js/dist/solid.js";
  const profile = {
    startTime: 1_000,
    endTime: 121_000,
    nodes: [
      node(1, "(root)", "", [2, 5, 7]),
      node(2, "renderTranscript", transcript, [3], 20, 4),
      node(3, "flush", solid, [4], 10, 0),
      node(4, "appendChild"),
      node(5, "updateSettings", settings, [6], 30, 2),
      node(6, "flush", solid, [], 10, 0),
      node(7, "(garbage collector)"),
    ],
    samples: [4, 4, 7, 6, 6, 6],
    timeDeltas: Array.from({ length: 6 }, () => 20_000),
  };
  const interval = (startUs: number) => ({ startUs, endUs: startUs + 60_000, durationMs: 60 });
  const task = (startUs: number, sampledMs: number) => ({
    ...interval(startUs),
    sampledMs,
    uncoveredMs: 60 - sampledMs,
  });
  expect(
    summarizeLongTaskCpuProfiles(profile, [1_000, 61_000, 101_000, 121_000].map(interval)),
  ).toMatchObject([
    {
      ...task(1_000, 60),
      unattributedMs: 20,
      owner: {
        functionName: "renderTranscript",
        url: transcript,
        attributedMs: 40,
      },
      hotspots: [
        { functionName: "appendChild", selfMs: 40 },
        { functionName: "(garbage collector)", selfMs: 20 },
      ],
    },
    {
      ...task(61_000, 60),
      unattributedMs: 0,
      owner: {
        functionName: "updateSettings",
        url: settings,
        attributedMs: 60,
      },
      hotspots: [{ functionName: "flush", selfMs: 60 }],
    },
    {
      ...task(101_000, 20),
      owner: { functionName: "updateSettings", attributedMs: 20 },
    },
    {
      ...task(121_000, 0),
      owner: null,
      sourceOwners: [],
      hotspots: [],
    },
  ]);
});

it("ranks Chromium selector snapshots inside the renderer interval without merging stylesheets", () => {
  // The wire names match Chromium's ElementRuleCollector::DumpAndClearRulesPerfMap.
  const timing = (styleSheetId: string, elapsedUs: number, attempts: number) => ({
    selector: ".row",
    style_sheet_id: styleSheetId,
    "elapsed (us)": elapsedUs,
    match_attempts: attempts,
    match_count: 1,
    fast_reject_count: attempts - 1,
  });
  const event = (ts: number, pid: number, timings: unknown[]) => ({
    name: "SelectorStats",
    ph: "X",
    ts,
    dur: 1,
    pid,
    tid: 1,
    args: { selector_stats: { selector_timings: timings } },
  });
  const sheet = {
    sourceURL: "http://localhost/assets/rows.css",
    origin: "regular",
    title: "",
    startLine: 0,
    startColumn: 0,
  };
  const interval = { startUs: 100, endUs: 200, rendererPid: 7, rendererTid: 1 };
  expect(
    summarizeInteractionSelectors(
      [
        event(50, 7, [timing("sheet-a", 1_000, 100)]),
        event(110, 9, [timing("sheet-a", 1_000, 100)]),
        { ...event(115, 7, []), args: {} },
        event(120, 7, [timing("sheet-a", 12, 5), timing("sheet-b", 50, 2)]),
        event(150, 7, [timing("sheet-a", 20, 8)]),
        event(250, 7, [timing("sheet-a", 1_000, 100)]),
      ],
      interval,
      new Map([["sheet-a", sheet]]),
    ),
  ).toEqual({
    stylePasses: 2,
    selectors: [
      {
        selector: ".row",
        styleSheetId: "sheet-b",
        elapsedUs: 50,
        matchAttempts: 2,
        matches: 1,
        fastRejects: 1,
      },
      {
        selector: ".row",
        styleSheetId: "sheet-a",
        styleSheet: sheet,
        elapsedUs: 32,
        matchAttempts: 13,
        matches: 2,
        fastRejects: 11,
      },
    ],
  });
  expect(() =>
    summarizeInteractionSelectors([event(150, 7, [{ selector: ".invalid" }])], interval),
  ).toThrow("Invalid Chromium selector timing");
  expect(() =>
    summarizeInteractionSelectors(
      [{ ...event(150, 7, []), args: { selector_stats: {} } }],
      interval,
    ),
  ).toThrow("SelectorStats event is missing selector_timings");
});

it("clips CPU sample contributions to marks after ordering signed sample timestamps", () => {
  const profile = {
    startTime: 1_000_000,
    endTime: 1_006_000,
    nodes: [],
    samples: [1, 3, 2, 4, 5],
    timeDeltas: [1_000, 2_000, -1_000, 2_000, 1_000],
  };
  const clipped = clipInteractionCpuProfile(profile, 1_001_500, 1_003_500);
  expect(clipped).toEqual({
    ...profile,
    startTime: 1_001_500,
    endTime: 1_003_500,
    samples: [2, 3, 4],
    timeDeltas: [500, 1_000, 500],
  });
  expect(profile.timeDeltas).toEqual([1_000, 2_000, -1_000, 2_000, 1_000]);
  expect(() => clipInteractionCpuProfile(profile, 1_006_000, 1_007_000)).toThrow(
    "no samples in the marked interval",
  );
});
