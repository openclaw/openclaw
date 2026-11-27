import { describe, expect, it } from "vitest";
import { summarizeControlUiNativeTrace } from "../../scripts/lib/control-ui-native-trace.ts";

const thread = (pid = 7, tid = 1) => ({
  name: "thread_name",
  ph: "M",
  ts: 0,
  pid,
  tid,
  args: { name: "CrRendererMain" },
});
const event = (name: string, ts: number, dur: number, extra: object = {}) => ({
  name,
  ts,
  dur,
  ph: "X",
  pid: 7,
  tid: 1,
  ...extra,
});
const profile = (samples: number[], timeDeltas: number[], endTime = 10_000) => ({
  startTime: 0,
  endTime,
  nodes: [
    { id: 1, callFrame: { functionName: "(program)" } },
    { id: 2, callFrame: { functionName: "render" } },
  ],
  samples,
  timeDeltas,
});

describe("native trace accounting", () => {
  it("unions same-category spans and gives nested categories exclusive wall and CPU time", () => {
    const result = summarizeControlUiNativeTrace(
      [
        thread(),
        event("UpdateLayoutTree", 0, 10_000, { tts: 0, tdur: 7_000 }),
        event("RecalculateStyles", 500, 500, { tts: 100, tdur: 400 }),
        event("Layout", 2_000, 5_000, { tts: 1_000, tdur: 3_000 }),
        event("PrePaint", 7_000, 2_000, { tts: 4_000, tdur: 2_000 }),
      ],
      null,
    );
    expect(result.mainThread).toMatchObject({
      wallMs: 10,
      threadCpuMs: 7,
      categories: {
        style: { events: 2, wallMs: 3, threadCpuMs: 2, cpuClockEvents: 2 },
        layout: { events: 1, wallMs: 5, threadCpuMs: 3 },
        prePaint: { events: 1, wallMs: 2, threadCpuMs: 2 },
      },
    });
    expect(result.eventNames).toContainEqual({ name: "Layout", category: "layout", count: 1 });
    expect(result.program.available).toBe(false);
  });

  it("matches B/E across unclassified nesting and selects the navigated renderer", () => {
    const result = summarizeControlUiNativeTrace(
      [
        thread(99),
        event("RunTask", 0, 100_000, { pid: 99 }),
        event("Paint", 0, 100_000, { pid: 99 }),
        thread(),
        { ...event("navigationStart", 0, 0), ph: "I" },
        { ...event("ParseHTML", 9_000, 0), ph: "E", tts: 5_000 },
        { ...event("ParseHTML", 1_000, 0), ph: "B", tts: 500 },
        { ...event("unknown", 2_000, 0), ph: "B", tts: 1_000 },
        { ...event("unknown", 3_000, 0), ph: "E", tts: 1_500 },
        event("v8.compile", 2_000, 5_000, { tid: 2, tts: 0, tdur: 4_000 }),
        event("v8.compile", 2_000, 5_000, { tid: 3, tts: 0, tdur: 3_000 }),
      ],
      null,
    );
    expect(result).toMatchObject({
      rendererPid: 7,
      rendererTid: 1,
      mainThread: { wallMs: 8, threadCpuMs: 4.5, categories: { htmlParse: { events: 1 } } },
      otherRendererThreads: { wallMs: 10, threadCpuMs: 7 },
    });
    expect(result.eventNames).toContainEqual({ name: "unknown", category: undefined, count: 1 });
  });

  it("keeps missing nested thread clocks unknown without discarding separate measured work", () => {
    const result = summarizeControlUiNativeTrace(
      [
        thread(),
        event("UpdateLayoutTree", 0, 10_000, { tts: 0, tdur: 7_000 }),
        event("Layout", 2_000, 5_000),
        event("Paint", 11_000, 2_000, { tts: 8_000, tdur: 1_000 }),
      ],
      null,
    );
    expect(result.mainThread).toMatchObject({
      wallMs: 12,
      threadCpuMs: null,
      categories: {
        style: { wallMs: 5, threadCpuMs: null, cpuClockEvents: 1 },
        layout: { wallMs: 5, threadCpuMs: null, cpuClockEvents: 0 },
        paint: { wallMs: 2, threadCpuMs: 1, cpuClockEvents: 1 },
      },
    });
  });

  it("correlates only the actual program sample intervals with exclusive trace slices", () => {
    const result = summarizeControlUiNativeTrace(
      [
        thread(),
        event("UpdateLayoutTree", 2_000, 4_000),
        event("Layout", 4_000, 1_000),
        event("Paint", 8_000, 2_000),
      ],
      profile([2, 1, 2], [1_000, 7_000, 2_000]),
    );
    expect(result.program).toMatchObject({
      available: true,
      sampledWallMs: 10,
      programSampledWallMs: 7,
      explainedProgramSampledWallMs: 4,
      unexplainedProgramSampledWallMs: 3,
      byCategory: { style: 3, layout: 1, paint: 0 },
    });
  });

  it("sorts signed sample deltas before assigning preceding intervals and retains unsampled tails", () => {
    const result = summarizeControlUiNativeTrace(
      [thread(), event("Paint", 3_000, 2_000), event("Layout", 5_000, 3_000)],
      profile([2, 1, 1], [5_000, -2_000, 5_000]),
    );
    expect(result.program).toMatchObject({
      available: true,
      outOfOrderSamples: 1,
      sampledWallMs: 8,
      unsampledWallMs: 2,
      programSampledWallMs: 6,
      explainedProgramSampledWallMs: 3,
      unexplainedProgramSampledWallMs: 3,
      byCategory: { paint: 0, layout: 3 },
    });
  });

  it("excludes the census profiler lead-in while preserving raw profile totals", () => {
    const result = summarizeControlUiNativeTrace(
      [thread(), event("Paint", 0, 2_000), event("UpdateLayoutTree", 6_000, 1_000)],
      profile([1, 2, 1], [2_000, 3_000, 5_000]),
    );
    expect(result.program).toMatchObject({
      profilerLeadInMs: 2,
      rawSampledWallMs: 10,
      rawProgramSampledWallMs: 7,
      sampledWallMs: 8,
      unsampledWallMs: 0,
      programSampledWallMs: 5,
      explainedProgramSampledWallMs: 1,
      unexplainedProgramSampledWallMs: 4,
      byCategory: { paint: 0, style: 1 },
    });
  });

  it("requires a named renderer and an aligned profile instead of guessing", () => {
    expect(() => summarizeControlUiNativeTrace([event("Paint", 0, 1_000)], null)).toThrow(
      "no CrRendererMain",
    );
    expect(() => summarizeControlUiNativeTrace([thread()], { samples: [1] })).toThrow(
      "complete CDP CPU profile",
    );
    expect(() => summarizeControlUiNativeTrace([thread()], profile([1], [-1]))).toThrow(
      "outside the profile interval",
    );
  });
});
