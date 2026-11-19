import { defaultRangeExtractor, Virtualizer } from "@tanstack/virtual-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

afterEach(() => vi.unstubAllGlobals());

function mockAnimationFrames() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    pending: () => frames.size,
    paint: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(16 * nextFrame));
    },
  };
}

function createPendingWheelRange(viewport = 300) {
  const invalidate = vi.fn();
  const rows = Array.from({ length: 200 }, (_, index) => ({
    kind: "item" as const,
    key: String(index),
    item: index,
    retainDom: true,
    prewarm: true,
  }));
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    initialRect: { width: 800, height: viewport },
    initialOffset: 6000,
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
    invalidate,
    () => 0,
    () => true,
    () => 120,
    queueMicrotask,
    () => false,
    () => true,
  );
  range.updateRows(rows);
  virtualizer.setOptions({
    ...virtualizer.options,
    rangeExtractor: (window) => range.extract(window),
  });
  range.presentation(rows);
  range.finish();
  onTestFinished(() => range.disconnect());
  return { range, virtualizer, invalidate, present: () => range.presentation(rows) };
}

it.each([
  { direction: 1, first: ["54", "55", "56"], accumulated: ["58", "59", "60"] },
  { direction: -1, first: ["46", "47", "48"], accumulated: ["42", "43", "44"] },
])(
  "prepares pending wheel travel before offsets arrive ($direction)",
  ({ direction, first, accumulated }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 1;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    const { range, virtualizer, present } = createPendingWheelRange();
    const active = present().activeRowKeys;
    range.recordWheel(direction * 480);
    expect(present().forecastRowKeys).toEqual(new Set(first));
    expect(present().activeRowKeys).toEqual(active);
    expect(virtualizer.scrollOffset).toBe(6000);

    range.recordWheel(direction * 480);
    expect(present().forecastRowKeys).toEqual(new Set(accumulated));
    range.recordReaderMovement(direction * 240);
    virtualizer.scrollOffset = 6000 + direction * 240;
    expect(present().forecastRowKeys).toEqual(new Set(accumulated));

    // Opposite native motion retires the speculative destination.
    range.recordReaderMovement(-direction * 120);
    virtualizer.scrollOffset = 6000 + direction * 120;
    for (const key of accumulated) {
      expect(present().forecastRowKeys.has(key)).toBe(false);
    }
    range.recordWheel(direction * 480);
    expect(present().forecastRowKeys.size).toBeGreaterThan(0);
    now = 102;
    vi.advanceTimersByTime(100);
    expect(present().forecastRowKeys.size).toBe(0);
  },
);

it.each([
  { delta: 2400, expected: ["70", "71", "72", "73"] },
  { delta: -2400, expected: ["39", "38", "37", "36"] },
])("bounds a pending destination to the existing row allowance ($delta)", ({ delta, expected }) => {
  const { range, virtualizer, present } = createPendingWheelRange(1200);
  const activeCount = present().activeRowKeys.size;
  range.recordWheel(delta);
  expect(present().forecastRowKeys).toEqual(new Set(expected));
  expect(virtualizer.getVirtualItems().length).toBeLessThanOrEqual(activeCount + 4);
  range.disconnect();
  expect(present().forecastRowKeys.size).toBe(0);
});

it.each([
  { direction: 1, residual: 0, expected: ["58", "59", "60"] },
  { direction: -1, residual: 0, expected: ["42", "43", "44"] },
  { direction: 1, residual: 0.5, expected: ["58", "59", "60"] },
  { direction: -1, residual: 0.5, expected: ["42", "43", "44"] },
])(
  "covers the next wheel viewport after native consumption ($direction, residual $residual)",
  ({ direction, residual, expected }) => {
    const { range, virtualizer, present } = createPendingWheelRange();
    range.recordWheel(direction * (480 + residual));
    range.recordReaderMovement(direction * 480);
    virtualizer.scrollOffset = 6000 + direction * 480;
    expect(present().forecastRowKeys).toEqual(new Set(expected));
    range.recordWheel(0);
    expect(present().forecastRowKeys).toEqual(new Set(expected));
  },
);

it("renews a consumed wheel forecast without publishing an unchanged window", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 1;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const { range, virtualizer, invalidate, present } = createPendingWheelRange();
  range.recordReaderMovement(480);
  virtualizer.scrollOffset = 6480;
  range.recordWheel(0);
  const forecast = present().forecastRowKeys;
  expect(forecast.size).toBeGreaterThan(0);
  invalidate.mockClear();

  now = 51;
  vi.advanceTimersByTime(50);
  range.recordWheel(0);
  expect(invalidate).not.toHaveBeenCalled();
  expect(present().forecastRowKeys).toEqual(forecast);
  now = 102;
  vi.advanceTimersByTime(51);
  expect(invalidate).not.toHaveBeenCalled();
  expect(present().forecastRowKeys.size).toBe(0);
  now = 151;
  vi.advanceTimersByTime(49);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(present().forecastRowKeys.size).toBe(0);
});

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
  const animation = mockAnimationFrames();
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
  let presented = true;
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    () => [],
    () => {},
    () => 0,
    () => presented,
    () => 100,
    queueMicrotask,
    () => {
      events.push("measure");
      return remainingCorrections-- > 0;
    },
    () => true,
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
    animation.paint();
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
  presented = false;
  await paint();
  expect(events).toEqual(["measure", "frame", "measure", "frame"]);
  presented = true;
  range.didCommit();
  await paint();
  expect(events).toEqual(["measure", "frame", "measure", "frame", "frame", "measure", "scroll"]);
  range.finishEnd();
  expect(range.preparingEnd).toBe(false);
  expect(animation.pending()).toBe(0);
});

it("retains the measured destination until the Latest journey settles", async () => {
  const animation = mockAnimationFrames();
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 20,
    initialOffset: 0,
    initialRect: { width: 800, height: 300 },
    getScrollElement: () => null,
    estimateSize: () => 100,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  const rows = Array.from({ length: 20 }, (_, index): TranscriptRow => ({
    kind: "content",
    key: `row-${index}`,
    content: null,
  }));
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    defaultRangeExtractor,
    () => {},
    () => 0,
    () => true,
    () => 100,
    queueMicrotask,
    () => false,
    () => true,
  );
  onTestFinished(() => range.disconnect());
  range.updateRows(rows);
  range.presentation(rows);
  range.finish();
  const ready = vi.fn();
  range.prepareEnd(ready, () => true, false);
  await Promise.resolve();
  animation.paint();
  expect(ready).toHaveBeenCalledOnce();
  // Issuing a smooth command does not move the native viewport immediately.
  // Its destination must stay in flow while offsets and row measurements arrive.
  const start = { startIndex: 0, endIndex: 2, count: 20, overscan: 1 };
  expect(range.extract(start)).toContain(19);
  expect(range.presentation(rows).activeRowKeys.has("row-19")).toBe(true);
  range.finishEnd();
  expect(range.extract(start)).not.toContain(19);
});

it.each([false, true])(
  "settles a measured end after three stable frames (cancelled: %s)",
  (cancelled) => {
    const animation = mockAnimationFrames();
    const paint = animation.paint;
    const element = document.createElement("div");
    let height = 1000;
    Object.defineProperties(element, {
      clientHeight: { value: 300 },
      scrollHeight: { get: () => height },
    });
    element.scrollTop = 700;
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 20,
      initialRect: { width: 800, height: 300 },
      getScrollElement: () => element,
      estimateSize: () => 50,
      scrollToFn: () => {},
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
    });
    virtualizer.scrollElement = element;
    let measured = false;
    let presented = true;
    const range = new TranscriptInitialRange(
      0,
      () => virtualizer,
      defaultRangeExtractor,
      () => {},
      () => 0,
      () => presented,
      () => 50,
      queueMicrotask,
      () => false,
      () => measured,
    );
    onTestFinished(() => range.disconnect());
    range.finishEndWhenSettled();
    paint();
    paint();
    paint();
    expect(range.preparingEnd).toBe(true);
    presented = false;
    paint();
    expect(animation.pending()).toBe(0);
    presented = true;
    range.didCommit();
    measured = true;
    paint();
    height += 1;
    element.scrollTop += 1;
    paint();
    element.scrollTop -= 9;
    paint();
    expect(range.preparingEnd).toBe(true);
    element.scrollTop += 1;
    paint();
    paint();
    expect(range.preparingEnd).toBe(true);
    if (cancelled) {
      range.recordReaderMovement(-20);
    }
    paint();
    expect(range.preparingEnd).toBe(false);
    expect(animation.pending()).toBe(0);
  },
);

it.each([
  { delta: 1200, expected: [40] },
  { delta: -1200, expected: [22] },
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
    // The next viewport overlaps ordinary overscan. Prepare its first new row,
    // not an overscan row whose DOM is already mounted.
    range.recordReaderMovement(Math.sign(delta) * 240);
    expect(range.presentation(rows).forecastRowKeys).toContain(delta > 0 ? "34" : "28");
    const distantKey = delta > 0 ? "80" : "1";
    range.preparedRowKeys.add(distantKey);
    range.recordReaderMovement(delta);
    const presentation = range.presentation(rows);
    expect(virtualizer.getVirtualItems().some((item) => item.key === distantKey)).toBe(true);
    expect(presentation.forecastRowKeys.has(distantKey)).toBe(false);
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

    if (delta < 0) {
      // An upward fling can overshoot zero; extraction and painting share its clamped viewport.
      now = 201;
      virtualizer.scrollOffset = 600;
      range.recordReaderMovement(delta);
      expect(range.presentation(rows).forecastRowKeys).toContain("2");
    }
  },
);

it.each(["cancel", "parked replacement"] as const)(
  "retains %s ownership through settlement invalidation",
  async (change) => {
    const animation = mockAnimationFrames();
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 1,
      getScrollElement: () => null,
      estimateSize: () => 100,
      scrollToFn: () => {},
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
    });
    let presented = true;
    let invalidate = () => {};
    const range = new TranscriptInitialRange(
      0,
      () => virtualizer,
      defaultRangeExtractor,
      () => invalidate(),
      () => 0,
      () => presented,
      () => 100,
      queueMicrotask,
      () => false,
      () => true,
    );
    onTestFinished(() => range.disconnect());
    range.finish();
    const replacementReady = vi.fn();
    let changed = false;
    invalidate = () => {
      if (changed || !range.preparingEnd) {
        return;
      }
      changed = true;
      if (change === "cancel") {
        range.finishEnd();
      } else {
        presented = false;
        range.prepareEnd(replacementReady, () => true, false);
      }
    };
    range.finishEndWhenSettled();
    expect(changed).toBe(true);
    if (change === "cancel") {
      expect(range.preparingEnd).toBe(false);
      expect(animation.pending()).toBe(0);
    } else {
      await Promise.resolve();
      animation.paint();
      expect(replacementReady).not.toHaveBeenCalled();
      presented = true;
      range.didCommit();
      animation.paint();
      expect(replacementReady).toHaveBeenCalledOnce();
      expect(range.preparingEnd).toBe(true);
    }
  },
);
