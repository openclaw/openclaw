import { defaultRangeExtractor, Virtualizer } from "@tanstack/virtual-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";

afterEach(() => vi.unstubAllGlobals());

it("keeps following rows during a viewport-sized jump past shorter-than-estimated rows", () => {
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 20,
    initialRect: { width: 800, height: 300 },
    getScrollElement: () => null,
    estimateSize: () => 120,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    defaultRangeExtractor,
    () => {},
    () => 0,
    () => true,
    () => 120,
    queueMicrotask,
    () => false,
    () => false,
  );
  onTestFinished(() => range.disconnect());
  range.recordReaderMovement(1000);

  // A collapsed work summary can shrink from its 120px estimate to 32.5px.
  // Keep the adjacent row available to fill the arriving viewport immediately.
  const indexes = range.extract({ startIndex: 10, endIndex: 12, count: 20, overscan: 1 });
  expect(indexes).toContain(13);
});

it("yields between destination-size corrections and waits for a stable end before scrolling", async () => {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 1,
    getScrollElement: () => null,
    estimateSize: () => 100,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  const events: string[] = [];
  let remainingCorrections = 2;
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    () => [],
    () => {},
    () => 0,
    () => true,
    () => 100,
    queueMicrotask,
    () => {
      events.push("measure");
      return remainingCorrections-- > 0;
    },
    () => false,
  );
  onTestFinished(() => range.disconnect());
  const settleCommits = async () => {
    // Three chained commit callbacks would complete all corrections without yielding.
    for (let turn = 0; turn < 4; turn++) {
      await Promise.resolve();
    }
  };
  const paint = async () => {
    events.push("frame");
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(16 * nextFrame));
    await settleCommits();
  };

  range.prepareEnd(
    () => events.push("scroll"),
    () => true,
    false,
  );
  await settleCommits();
  expect(events).toEqual(["measure"]);
  await paint();
  expect(events).toEqual(["measure", "frame", "measure"]);
  await paint();
  expect(events).toEqual(["measure", "frame", "measure", "frame", "measure", "scroll"]);
  expect(range.preparingEnd).toBe(false);
  expect(frames.size).toBe(0);
});

it.each([
  { delta: 1200, expected: [40, 41, 42] },
  { delta: -1200, expected: [20, 21, 22] },
])(
  "keeps approaching rows paintable until active admission during a $delta px fling",
  ({ delta, expected }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      kind: "item" as const,
      key: String(index),
      item: index,
      retainDom: true,
    }));
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: rows.length,
      initialRect: { width: 800, height: 300 },
      initialOffset: 3600,
      getItemKey: (index) => String(index),
      getScrollElement: () => null,
      estimateSize: () => 120,
      scrollToFn: () => {},
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
    });
    const range = new TranscriptInitialRange(
      0,
      () => virtualizer,
      defaultRangeExtractor,
      () => {},
      () => 0,
      () => true,
      () => 120,
      queueMicrotask,
      () => false,
      () => false,
    );
    onTestFinished(() => {
      range.disconnect();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    range.updateRows(rows);
    virtualizer.setOptions({
      ...virtualizer.options,
      rangeExtractor: (window) => range.extract(window),
    });
    range.presentation(rows);
    range.finish();
    range.recordReaderMovement(delta);
    const presentation = range.presentation(rows);
    expect(presentation.forecastRowKeys.size).toBe(expected.length);
    for (const index of expected) {
      expect(presentation.forecastRowKeys.has(String(index))).toBe(true);
      expect(presentation.activeRowKeys.has(String(index))).toBe(false);
    }

    // Faster input does not extrapolate past the approaching viewport.
    const step = delta / 2;
    now = 17;
    range.recordReaderMovement(step);
    virtualizer.scrollOffset = 3600 + step;
    const approaching = range.presentation(rows);
    expect(approaching.forecastRowKeys).toEqual(new Set(expected.map(String)));
    const mounted = new Set(virtualizer.getVirtualItems().map((item) => String(item.key)));
    for (const index of expected) {
      expect(mounted.has(String(index))).toBe(true);
      expect(approaching.activeRowKeys.has(String(index))).toBe(false);
    }

    now = 33;
    range.recordReaderMovement(step);
    virtualizer.scrollOffset = 3600 + delta;
    const admitted = range.presentation(rows);
    for (const index of expected) {
      expect(admitted.activeRowKeys.has(String(index))).toBe(true);
      expect(admitted.forecastRowKeys.has(String(index))).toBe(false);
    }

    now = 134;
    vi.advanceTimersByTime(100);
    expect(range.presentation(rows).forecastRowKeys.size).toBe(0);
  },
);
