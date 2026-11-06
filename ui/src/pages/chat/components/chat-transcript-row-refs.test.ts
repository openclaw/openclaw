/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { measureTranscriptRow, readConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import { createTranscriptPresentation } from "./chat-transcript-session.ts";
import {
  installTranscriptDomMocks,
  observedElements,
  resetTranscriptTestDom,
  resizeObservers,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("retains row measurements across hidden and detached observer receipts", async () => {
  const viewport = document.body.appendChild(document.createElement("div"));
  const row = viewport.appendChild(document.createElement("div"));
  row.dataset.index = "0";
  row.dataset.virtualRowKey = "retained";
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 1,
    getScrollElement: () => viewport,
    getItemKey: () => "retained",
    estimateSize: () => 100,
    observeElementRect: (_, callback) => callback({ width: 800, height: 300 }),
    observeElementOffset: (_, callback) => callback(0, false),
    scrollToFn: vi.fn(),
    measureElement: measureTranscriptRow,
  });
  const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = virtualizer;
  onTestFinished(mountVirtualizer());
  updateVirtualizer();
  virtualizer.getVirtualItems();
  const refs = new TranscriptRowRefs(virtualizer, {
    isCurrentRow: (element) => viewport.contains(element),
    beforeMeasure: () => {},
    onMount: () => {},
  });
  const bind = refs.forKey("retained");
  bind(row);
  await Promise.resolve();
  expect(virtualizer.elementsCache.get("retained")).toBe(row);

  viewport.remove();
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 0, 0);
  }
  expect(virtualizer.elementsCache.has("retained")).toBe(false);
  expect(observedElements.has(row)).toBe(false);

  // The transcript island returns without remounting its retained Solid rows.
  document.body.append(viewport);
  expect([...refs.elements]).toEqual([row]);
  refs.observeConnected();
  expect(virtualizer.elementsCache.get("retained")).toBe(row);
  expect(observedElements.has(row)).toBe(true);
  row.style.height = "160px";
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 800, 160);
  }
  expect(virtualizer.itemSizeCache.get("retained")).toBe(160);

  // Observer receipts invalidate current geometry; a hidden native box keeps
  // its last measurement until the retained row becomes visible again.
  Object.defineProperty(viewport, "clientHeight", { value: 300 });
  row.style.height = "0px";
  const bounds = vi.spyOn(row, "getBoundingClientRect");
  bounds.mockReturnValue(new DOMRect(0, 0, 0, 0));
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 0, 0);
  }
  expect(virtualizer.itemSizeCache.get("retained")).toBe(160);
  bounds.mockReturnValue(new DOMRect(0, 0, 800, 0));
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 800, 0);
  }
  expect(virtualizer.itemSizeCache.get("retained")).toBe(0);

  row.remove();
  bind();
  await Promise.resolve();
  expect([...refs.elements]).toEqual([]);
  expect(virtualizer.elementsCache.has("retained")).toBe(false);
  expect(observedElements.has(row)).toBe(false);
});

it.each([
  { kind: "cached", scrolling: true, indexes: [0, 1, 2] },
  { kind: "overscan", scrolling: true, indexes: [6, 7, 8] },
  { kind: "cold idle", scrolling: false, indexes: [0, 1, 2] },
  { kind: "cold scrolling", scrolling: true, indexes: [0, 1, 2] },
  { kind: "re-stamped", scrolling: false, indexes: [0, 1, 2], restamped: true },
  { kind: "later microtask", scrolling: true, indexes: [0, 1], deferred: true },
])("defers $kind measurement without layout reads", async (scenario) => {
  const { kind, scrolling, indexes, deferred, restamped } = scenario;
  const viewport = document.body.appendChild(document.createElement("div"));
  const rows = Array.from({ length: 12 }, (_, index) => {
    const row = viewport.appendChild(document.createElement("div"));
    row.dataset.index = String(index);
    row.dataset.virtualRowKey = String(index);
    return row;
  });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    getScrollElement: () => viewport,
    getItemKey: (index) => String(index),
    estimateSize: () => 100,
    observeElementRect: (_, callback) => callback({ width: 800, height: 300 }),
    observeElementOffset: (_, callback) => callback(0, scrolling),
    scrollToFn: vi.fn(),
    measureElement: (element, entry) => presentation.measureElement(element, entry),
  });
  const presentation = createTranscriptPresentation(
    () => viewport,
    virtualizer,
    () => rows,
    () => void viewport.scrollTop,
  );
  const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = virtualizer;
  onTestFinished(mountVirtualizer());
  updateVirtualizer();
  virtualizer.getVirtualItems();
  const readViewport = vi.fn(() => 300);
  const readOffset = vi.fn(() => 0);
  const readStyle = vi.spyOn(globalThis, "getComputedStyle");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: readViewport });
  Object.defineProperty(viewport, "scrollTop", { configurable: true, get: readOffset });
  const refs = new TranscriptRowRefs(virtualizer, {
    isCurrentRow: (row) => viewport.contains(row),
    beforeMeasure: () => void viewport.scrollTop,
    onMount: () => {},
  });
  const mounted = indexes.map((index) => expectDefined(rows[index], "mounted row"));
  let height = deferred ? 160 : 80;
  const readHeight = vi.fn(() => height);
  for (const [position, index] of indexes.entries()) {
    const row = mounted[position]!;
    Object.defineProperty(row, "offsetHeight", { configurable: true, get: readHeight });
    if (kind === "cached") {
      virtualizer.resizeItem(index, 80);
    }
    if (restamped) {
      refs.forKey(String(index))();
    }
    if (deferred && index === 1) {
      queueMicrotask(() => {
        refs.forKey("1")(row);
        queueMicrotask(() => {
          height = 80;
        });
      });
    } else {
      refs.forKey(String(index))(row);
    }
  }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect([readHeight.mock.calls, readViewport.mock.calls, readOffset.mock.calls]).toEqual([
    [],
    [],
    [],
  ]);
  expect(readStyle).not.toHaveBeenCalled();
  expect(mounted.every((row) => observedElements.has(row))).toBe(true);
  for (const observer of resizeObservers) {
    for (const row of mounted) {
      row.style.height = `${height}px`;
    }
    observer.emit(800, height);
  }
  expect([...virtualizer.itemSizeCache.values()]).toEqual(indexes.map(() => 80));
  expect(readHeight).not.toHaveBeenCalled();
  expect(readOffset).toHaveBeenCalledTimes(1);

  await Promise.resolve();
  readOffset.mockReturnValue(10);
  for (const row of mounted) {
    row.style.height = "90px";
  }
  for (const observer of resizeObservers) {
    observer.emit(800, 90);
  }
  expect([...virtualizer.itemSizeCache.values()]).toEqual(indexes.map(() => 90));
  expect(readOffset).toHaveBeenCalledTimes(2);
});

it.each([
  { before: 206.688, after: 215.219 },
  { before: 215.219, after: 206.688 },
])(
  "keeps the current $after px row after a deferred $before px receipt",
  async ({ before, after }) => {
    const flushFrames = stubAnimationFrames();
    const viewport = document.body.appendChild(document.createElement("div"));
    const rows = [before, 100].map((height, index) => {
      const row = viewport.appendChild(document.createElement("div"));
      row.dataset.index = String(index);
      row.dataset.virtualRowKey = String(index);
      row.style.height = `${height}px`;
      return row;
    });
    const row = expectDefined(rows[0], "measured row");
    const readScaledBounds = vi.fn(() => new DOMRect(0, 0, 400, 50.1875));
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: readScaledBounds,
    });
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: rows.length,
      getScrollElement: () => viewport,
      getItemKey: (index) => String(index),
      estimateSize: () => 100,
      observeElementRect: (_, callback) => callback({ width: 800, height: 600 }),
      observeElementOffset: (_, callback) => callback(0, false),
      scrollToFn: vi.fn(),
      measureElement: measureTranscriptRow,
      useAnimationFrameWithResizeObserver: true,
    });
    const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = virtualizer;
    const dispose = mountVirtualizer();
    updateVirtualizer();
    virtualizer.getVirtualItems();
    const refs = new TranscriptRowRefs(virtualizer, {
      isCurrentRow: (element) => viewport.contains(element),
      beforeMeasure: () => {},
      onMount: () => {},
    });
    onTestFinished(() => {
      refs.clear();
      dispose();
    });
    rows.forEach((element, index) => refs.forKey(String(index))(element));
    await Promise.resolve();
    expect(observedElements.has(row)).toBe(true);
    expect(readConnectedTranscriptRows(viewport, virtualizer, refs.elements)?.()).toBe(true);
    const geometry = () => [
      virtualizer.itemSizeCache.get("0"),
      virtualizer.getVirtualItems()[1]?.start,
      virtualizer.getTotalSize(),
    ];
    expect(geometry()).toEqual([before, before, before + 100]);

    for (const observer of resizeObservers) {
      observer.emitTarget(row, 800, before);
    }
    row.style.height = `${after}px`;
    expect(readConnectedTranscriptRows(viewport, virtualizer, refs.elements)?.()).toBe(true);
    expect(geometry()).toEqual([after, after, after + 100]);

    // TanStack defers this captured receipt until after the newer foreground read.
    flushFrames();
    expect(geometry()).toEqual([after, after, after + 100]);
    expect(readScaledBounds).not.toHaveBeenCalled();
  },
);
