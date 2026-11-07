// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  installControlUiGestureProbe,
  summarizeGestureTrace,
  type GestureProbeOptions,
  type GestureProbeResult,
} from "../../scripts/lib/control-ui-gesture-probe.ts";

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

function startGestureProbe(options: GestureProbeOptions = {}) {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  installControlUiGestureProbe(options);
  const probe: { start(label: string): void; stop(): GestureProbeResult } = Reflect.get(
    window,
    "__openclawGestureProbe",
  );
  probe.start("synthetic-resize");
  return {
    frame(at: number) {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      scheduled.forEach((callback) => callback(at));
    },
    stop: () => probe.stop(),
  };
}

function measuredBox(element: HTMLElement, top: number, height: number) {
  // Layout is external input to the probe; jsdom does not calculate these boxes.
  element.checkVisibility = () => true;
  element.style.height = `${height}px`;
  return vi
    .spyOn(element, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, top, 300, height));
}

function transcriptGeometryFixture() {
  document.body.innerHTML = `<div class="chat-thread"><div class="chat-virtual-block">
    <div class="chat-virtual-row" data-index="0" data-row-size="40"><div class="chat-text">First message</div></div>
    <div class="chat-virtual-row" data-index="1" data-row-size="40"><div class="chat-text">Second message</div></div>
  </div></div>`;
  measuredBox(document.querySelector<HTMLElement>(".chat-thread")!, 0, 200);
  const rows = [...document.querySelectorAll<HTMLElement>(".chat-virtual-row")];
  const texts = [...document.querySelectorAll<HTMLElement>(".chat-text")];
  const rowBoxes = rows.map((row, index) => measuredBox(row, 10 + 40 * index, 40));
  const textBoxes = texts.map((text, index) => measuredBox(text, 15 + 40 * index, 30));
  return { rows, texts, rowBoxes, textBoxes };
}

afterEach(() => {
  Reflect.deleteProperty(window, "__openclawGestureProbe");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps transcript layout queries out of the ordinary timing path", () => {
  const query = vi.spyOn(document, "querySelectorAll");
  const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const styles = vi.spyOn(window, "getComputedStyle");
  const probe = startGestureProbe();
  probe.frame(16);
  probe.frame(32);
  const result = probe.stop();

  expect(result.mode).toBe("timing");
  expect(result.frames).toHaveLength(2);
  expect(result.transcriptGeometry).toBeUndefined();
  expect(query).not.toHaveBeenCalled();
  expect(bounds).not.toHaveBeenCalled();
  expect(styles).not.toHaveBeenCalled();
});

it("retains transient visible overlap and text clipping, then detects stale final row sizes", () => {
  const fixture = transcriptGeometryFixture();
  fixture.rowBoxes[1]!.mockReturnValue(new DOMRect(0, 40, 300, 40));
  fixture.textBoxes[1]!.mockReturnValue(new DOMRect(0, 45, 300, 40));
  const probe = startGestureProbe({ transcriptGeometry: true });
  probe.frame(16);
  fixture.rowBoxes[1]!.mockReturnValue(new DOMRect(0, 50, 300, 40));
  fixture.textBoxes[1]!.mockReturnValue(new DOMRect(0, 55, 300, 30));
  fixture.rows[1]!.dataset.rowSize = "41";
  const result = probe.stop();

  expect(result.mode).toBe("transcript-geometry-diagnostic");
  expect(result.transcriptGeometry?.frames[0]?.threads[0]?.rows[1]).toMatchObject({
    index: 1,
    rowOverlapPx: 10,
    textClipPx: 5,
  });
  expect(result.transcriptGeometry?.final.threads[0]?.rows[1]).toMatchObject({
    rowOverlapPx: 0,
    textClipPx: 0,
    cachedHeight: 41,
    measuredHeight: 40,
  });
  expect(result.transcriptGeometry?.failures).toEqual([
    "16: transcript 0 row 1: overlap 10, text clip 5",
    "Final transcript 0 row 1: cache 41, measured 40",
  ]);
});

it("ignores prepared rows while checking active rows at frame and final capture", () => {
  const fixture = transcriptGeometryFixture();
  const prepared = document.createElement("div");
  prepared.className = "chat-virtual-row";
  prepared.dataset.index = "2";
  prepared.dataset.rowSize = "999";
  prepared.dataset.preparedRow = "true";
  fixture.rows[1]!.after(prepared);
  const preparedBounds = measuredBox(prepared, 0, 1);
  const probe = startGestureProbe({ transcriptGeometry: true });
  probe.frame(16);
  const result = probe.stop();

  expect(result.transcriptGeometry?.frames[0]?.threads[0]?.rows.map((row) => row.index)).toEqual([
    0, 1,
  ]);
  expect(result.transcriptGeometry?.final.threads[0]?.rows).toHaveLength(2);
  expect(result.transcriptGeometry?.failures).toEqual([]);
  expect(preparedBounds).not.toHaveBeenCalled();
});

it("respects intentional collapsed-message clipping inside the row", () => {
  const fixture = transcriptGeometryFixture();
  const disclosure = document.createElement("div");
  disclosure.className = "chat-message-disclosure";
  const clip = document.createElement("div");
  clip.className = "chat-message-disclosure__content";
  fixture.rows[0]!.append(disclosure);
  disclosure.append(clip);
  clip.append(fixture.texts[0]!);
  measuredBox(clip, 15, 30);
  fixture.textBoxes[0]!.mockReturnValue(new DOMRect(0, 15, 300, 80));
  const probe = startGestureProbe({ transcriptGeometry: true });
  probe.frame(16);
  const result = probe.stop();

  expect(result.transcriptGeometry?.final.threads[0]?.rows[0]?.textClipPx).toBe(0);
  expect(result.transcriptGeometry?.failures).toEqual([]);
});
