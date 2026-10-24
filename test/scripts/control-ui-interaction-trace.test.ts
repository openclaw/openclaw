import { expect, it } from "vitest";
import {
  summarizeCpuProfile,
  type ColdLoadTraceEvent,
} from "../../scripts/lib/control-ui-cold-load-trace.ts";
import {
  clipInteractionCpuProfile,
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
    event("thread_name", "M", 0, { pid: 9, args: { name: "CrRendererMain" } }),
    event("navigationStart", "I", 0, { pid: 9 }),
    event("RunTask", "X", 0, { dur: 80_000 }),
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
    event("Layout", "X", 230_000, { dur: 300_000 }),
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
  const profile = {
    startTime: 1_000,
    endTime: 121_000,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
        children: [2, 5, 7],
      },
      {
        id: 2,
        callFrame: {
          functionName: "renderTranscript",
          url: "ui/src/components/chat/message-list.tsx",
          lineNumber: 20,
          columnNumber: 4,
        },
        children: [3],
      },
      {
        id: 3,
        callFrame: {
          functionName: "flush",
          url: "node_modules/solid-js/dist/solid.js",
          lineNumber: 10,
          columnNumber: 0,
        },
        children: [4],
      },
      {
        id: 4,
        callFrame: { functionName: "appendChild", url: "", lineNumber: -1, columnNumber: -1 },
      },
      {
        id: 5,
        callFrame: {
          functionName: "updateSettings",
          url: "ui/src/pages/settings/settings-page.tsx",
          lineNumber: 30,
          columnNumber: 2,
        },
        children: [6],
      },
      {
        id: 6,
        callFrame: {
          functionName: "flush",
          url: "node_modules/solid-js/dist/solid.js",
          lineNumber: 10,
          columnNumber: 0,
        },
      },
      {
        id: 7,
        callFrame: {
          functionName: "(garbage collector)",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
      },
    ],
    samples: [4, 4, 7, 6, 6, 6],
    timeDeltas: [20_000, 20_000, 20_000, 20_000, 20_000, 20_000],
  };
  expect(
    summarizeLongTaskCpuProfiles(profile, [
      { startUs: 1_000, endUs: 61_000, durationMs: 60 },
      { startUs: 61_000, endUs: 121_000, durationMs: 60 },
      { startUs: 101_000, endUs: 161_000, durationMs: 60 },
      { startUs: 121_000, endUs: 181_000, durationMs: 60 },
    ]),
  ).toMatchObject([
    {
      startUs: 1_000,
      endUs: 61_000,
      durationMs: 60,
      sampledMs: 60,
      uncoveredMs: 0,
      unattributedMs: 20,
      owner: {
        functionName: "renderTranscript",
        url: "ui/src/components/chat/message-list.tsx",
        attributedMs: 40,
      },
      hotspots: [
        { functionName: "appendChild", selfMs: 40 },
        { functionName: "(garbage collector)", selfMs: 20 },
      ],
    },
    {
      startUs: 61_000,
      endUs: 121_000,
      durationMs: 60,
      sampledMs: 60,
      uncoveredMs: 0,
      unattributedMs: 0,
      owner: {
        functionName: "updateSettings",
        url: "ui/src/pages/settings/settings-page.tsx",
        attributedMs: 60,
      },
      hotspots: [{ functionName: "flush", selfMs: 60 }],
    },
    {
      startUs: 101_000,
      endUs: 161_000,
      durationMs: 60,
      sampledMs: 20,
      uncoveredMs: 40,
      owner: { functionName: "updateSettings", attributedMs: 20 },
    },
    {
      startUs: 121_000,
      endUs: 181_000,
      durationMs: 60,
      sampledMs: 0,
      uncoveredMs: 60,
      owner: null,
      sourceOwners: [],
      hotspots: [],
    },
  ]);
});

it("clips CPU sample contributions to marks after ordering signed sample timestamps", () => {
  const profile = {
    startTime: 1_000_000,
    endTime: 1_006_000,
    nodes: [1, 2, 3, 4, 5].map((id) => ({
      id,
      callFrame: { functionName: `work${id}`, url: "app.ts", lineNumber: 0, columnNumber: 0 },
    })),
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
  expect(clipped.nodes).toBe(profile.nodes);
  expect(summarizeCpuProfile(clipped)).toMatchObject({
    sampledMs: 2,
    hotspots: [
      { functionName: "work3", selfMs: 1 },
      { functionName: "work2", selfMs: 0.5 },
      { functionName: "work4", selfMs: 0.5 },
    ],
  });
  expect(profile.timeDeltas).toEqual([1_000, 2_000, -1_000, 2_000, 1_000]);
  expect(() => clipInteractionCpuProfile(profile, 1_006_000, 1_007_000)).toThrow(
    "no samples in the marked interval",
  );
});
