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

it("mounts the expanded destination after a manual jump measures a shorter tail", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 20,
    initialRect: { width: 800, height: 300 },
    initialOffset: 0,
    getScrollElement: () => null,
    estimateSize: (index) => (index === 19 ? 1000 : 100),
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  let mounted: number[] = [];
  let measured: number[] = [];
  const range = new TranscriptInitialRange(
    0,
    () => virtualizer,
    defaultRangeExtractor,
    () => {
      mounted = virtualizer.getVirtualIndexes();
    },
    () => 0,
    () => true,
    () => 100,
    queueMicrotask,
    () => {
      measured = [...mounted];
      if (!mounted.includes(19) || virtualizer.itemSizeCache.has(19)) {
        return false;
      }
      virtualizer.resizeItem(19, 10);
      return true;
    },
    () => false,
  );
  onTestFinished(() => range.disconnect());
  const rows = Array.from({ length: 20 }, (_, index) => ({
    kind: "item" as const,
    key: String(index),
    item: index,
  }));
  range.updateRows(rows);
  range.finish();
  virtualizer.setOptions({
    ...virtualizer.options,
    rangeExtractor: (value) => range.extract(value),
  });
  range.presentation(rows);
  // Establish the current reader range before the offscreen destination is admitted.
  virtualizer.getVirtualIndexes();
  let destination: number[] | undefined;
  range.prepareEnd(
    () => {
      destination = [...measured];
    },
    () => true,
    false,
  );
  await Promise.resolve();
  await Promise.resolve();
  for (const frame of frames.splice(0)) {
    frame(16);
  }
  await Promise.resolve();
  expect(destination).toEqual(expect.arrayContaining([16, 17, 18, 19]));
});
