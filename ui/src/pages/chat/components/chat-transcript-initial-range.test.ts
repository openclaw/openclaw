import { defaultRangeExtractor, Virtualizer } from "@tanstack/virtual-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createFrameClock } from "../../../test-helpers/animation-frame-clock.ts";
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
    (indexes) => indexes.length === 0,
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

it("waits for a deferred destination commit and resumes it after parking", () => {
  const clock = createFrameClock();
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
  let renderPending = false;
  const invalidate = () => {
    renderPending = true;
  };
  const afterCommit: Array<() => void> = [];
  const heights: number[] = Array.from({ length: 20 }, (_, index) => (index === 19 ? 1000 : 100));
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: heights.length,
    initialRect: { width: 800, height: 300 },
    initialOffset: 0,
    getScrollElement: () => null,
    estimateSize: (index) => (index === 19 ? 1000 : 100),
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    onChange: invalidate,
  });
  let mounted: number[] = [];
  let presented = true;
  const measurements = new Map<number, number>();
  const measureRows = () => {
    let changed = false;
    for (const index of mounted) {
      const key = virtualizer.options.getItemKey(index);
      const previous = virtualizer.itemSizeCache.get(key);
      measurements.set(index, heights[index]!);
      virtualizer.resizeItem(index, heights[index]!);
      changed ||= virtualizer.itemSizeCache.get(key) !== previous;
    }
    return changed;
  };
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    defaultRangeExtractor,
    invalidate,
    () => 0,
    () => presented,
    () => 100,
    (effect) => afterCommit.push(effect),
    measureRows,
    (indexes) =>
      indexes.every(
        (index) => mounted.includes(index) && measurements.get(index) === heights[index],
      ),
  );
  onTestFinished(() => range.disconnect());
  const rows = heights.map((_height, index) => ({
    kind: "item" as const,
    key: String(index),
    item: index,
  }));
  range.updateRows(rows);
  range.finish(true);
  virtualizer.setOptions({
    ...virtualizer.options,
    rangeExtractor: (value) => range.extract(value),
  });
  range.presentation(rows);
  const commitRows = () => {
    if (renderPending) {
      renderPending = false;
      mounted = virtualizer.getVirtualIndexes();
    }
  };
  const runAfterCommit = () => {
    for (const effect of afterCommit.splice(0)) {
      effect();
    }
  };
  commitRows();
  measureRows();
  let destination: number[] | undefined;
  range.prepareEnd(
    () => {
      destination = [...mounted];
    },
    () => true,
    false,
  );
  commitRows();
  expect(mounted).toContain(19);
  expect(mounted).not.toContain(16);
  // A native size receipt invalidates the range after its DOM commit. The
  // queued preparation callback can run before that next render commits.
  heights[19] = 10;
  measurements.set(19, 10);
  virtualizer.resizeItem(19, 10);
  runAfterCommit();
  expect(destination).toBeUndefined();
  expect(range.preparingEnd).toBe(true);
  commitRows();
  expect(mounted).toEqual(expect.arrayContaining([16, 17, 18, 19]));
  runAfterCommit();
  presented = false;
  clock.flush(16);
  expect(destination).toBeUndefined();
  presented = true;
  for (let turn = 0; turn < 10; turn++) {
    if (!renderPending && !afterCommit.length && !clock.frames.size) {
      break;
    }
    commitRows();
    runAfterCommit();
    clock.flush(16);
  }
  expect(destination).toEqual(expect.arrayContaining([16, 17, 18, 19]));
  expect(range.preparingEnd).toBe(false);
  expect(clock.frames.size).toBe(0);
});
