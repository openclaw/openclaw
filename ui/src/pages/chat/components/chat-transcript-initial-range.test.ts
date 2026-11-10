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
