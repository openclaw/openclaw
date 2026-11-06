import { defaultRangeExtractor, Virtualizer } from "@tanstack/virtual-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([-1000, -150, 150, 1000])("prepares both sides during a fast %ipx scroll step", (delta) => {
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 20,
    getScrollElement: () => null,
    estimateSize: () => 120,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  virtualizer.scrollRect = { width: 800, height: 300 };
  virtualizer.scrollOffset = 1200;
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
  );
  onTestFinished(() => range.disconnect());
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  range.finish();
  expect(virtualizer.getVirtualIndexes()).toEqual([9, 10, 11, 12, 13]);
  range.recordReaderMovement(delta);

  // A collapsed work summary can shrink from its 120px estimate to 32.5px.
  // Both sides must remain available as the arriving window's estimates shrink.
  const indexes = virtualizer.getVirtualIndexes();
  expect(indexes).toContain(7);
  expect(indexes).toContain(15);
  // A later gesture must also invalidate extraction when it starts within the
  // same visible rows; the first wheel event is enough to prime lookahead.
  clock.mockReturnValue(1200);
  virtualizer.setOptions({ ...virtualizer.options, rangeExtractor: (next) => range.extract(next) });
  expect(virtualizer.getVirtualIndexes()).toEqual([9, 10, 11, 12, 13]);
  range.recordReaderMovement(1);
  expect(virtualizer.getVirtualIndexes()).toContain(15);
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
