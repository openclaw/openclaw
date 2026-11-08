import { expect, it } from "vitest";
import { summarizeGestureTrace } from "../../scripts/lib/control-ui-gesture-probe.ts";

it("keeps completion restyle counts and distinguishes native stacks from script nesting", () => {
  const event = (name: string, ph: string, ts: number, extra: object = {}) => ({
    name,
    ph,
    ts,
    pid: 7,
    tid: 1,
    ...extra,
  });
  const stack = [{ functionName: "measureRow", url: "synthetic-app.js", lineNumber: 12 }];
  const result = summarizeGestureTrace(
    [
      event("thread_name", "M", 0, { args: { name: "CrRendererMain" } }),
      event("FunctionCall", "B", 0),
      event("UpdateLayoutTree", "B", 10),
      event("UpdateLayoutTree", "E", 20, { args: { elementCount: 12 } }),
      event("Layout", "X", 30, { dur: 5, args: { beginData: { stackTrace: stack } } }),
      event("Layout", "X", 40, { dur: 5 }),
      event("FunctionCall", "E", 50),
      event("UpdateLayoutTree", "X", 60, { dur: 5, args: { endData: { elementCount: 0 } } }),
      event("Layout", "X", 70, { dur: 3 }),
      event("UpdateLayoutTree", "X", 80, { tid: 2, dur: 5, args: { elementCount: 999 } }),
    ],
    "chromium",
    4,
  );

  expect(result).toMatchObject({
    available: true,
    stylePasses: 2,
    layoutPasses: 3,
    stylePassesPerInput: 0.5,
    layoutPassesPerInput: 0.75,
    elementsRestyled: {
      available: true,
      measuredPasses: 2,
      missingPasses: 0,
      total: 12,
      meanPerMeasuredPass: 6,
      passes: [
        { atMs: 0.01, count: 12 },
        { atMs: 0.06, count: 0 },
      ],
    },
    forcedLayoutCount: 1,
    layoutsWithStackField: 1,
    forcedLayouts: [{ atMs: 0.03, durationMs: 0.005, stackTrace: stack }],
    scriptNestedLayoutCount: 2,
  });
});

it("reads WebKit child records without turning missing stack and element fields into zero", () => {
  const stack = [{ functionName: "getBoundingClientRect", url: "[native code]" }];
  const result = summarizeGestureTrace(
    [
      {
        type: "FunctionCall",
        startTime: 1,
        endTime: 1.1,
        children: [
          {
            type: "RecalculateStyles",
            startTime: 1.01,
            endTime: 1.02,
            data: { elementCount: 8 },
          },
          { type: "Layout", startTime: 1.03, endTime: 1.04 },
        ],
      },
      { type: "RecalculateStyles", startTime: 1.2, endTime: 1.3 },
      {
        type: "Layout",
        startTime: 1.4,
        endTime: 1.41,
        stackTrace: { callFrames: stack },
      },
    ],
    "webkit",
    0,
  );

  expect(result).toMatchObject({
    available: true,
    stylePasses: 2,
    layoutPasses: 2,
    stylePassesPerInput: null,
    layoutPassesPerInput: null,
    elementsRestyled: { measuredPasses: 1, missingPasses: 1, total: 8, meanPerMeasuredPass: 8 },
    forcedLayoutCount: 1,
    nativeLayoutStacksAvailable: true,
    layoutsWithStackField: 1,
    forcedLayouts: [{ atMs: 1_400, stackTrace: stack }],
    scriptNestedLayoutCount: 1,
  });
  expect(result.scriptNestedLayouts[0]?.atMs).toBeCloseTo(1_030);
  expect(result.scriptNestedLayouts[0]?.durationMs).toBeCloseTo(10);
  expect(
    summarizeGestureTrace([{ type: "Layout", startTime: 1, endTime: 2 }], "webkit", 1)
      .forcedLayoutCount,
  ).toBeNull();
});

it.each(["chromium", "webkit", "firefox"] as const)(
  "leaves unavailable %s trace metrics unknown",
  (engine) => {
    expect(summarizeGestureTrace([], engine, 10)).toMatchObject({
      available: false,
      stylePasses: null,
      layoutPasses: null,
      stylePassesPerInput: null,
      layoutPassesPerInput: null,
      elementsRestyled: { available: false, total: null, meanPerMeasuredPass: null },
      forcedLayoutCount: null,
      nativeLayoutStacksAvailable: false,
      scriptNestedLayoutCount: null,
    });
  },
);
