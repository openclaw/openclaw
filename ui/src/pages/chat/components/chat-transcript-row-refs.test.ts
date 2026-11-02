/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { measureTranscriptRow } from "./chat-transcript-geometry.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
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
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 800, 160);
  }
  expect(virtualizer.itemSizeCache.get("retained")).toBe(160);

  // The virtualizer applies ResizeObserver receipts in a later animation frame;
  // a hidden measurement can arrive after the pane is visible again.
  Object.defineProperty(viewport, "clientHeight", { value: 300 });
  for (const observer of resizeObservers) {
    observer.emitTarget(row, 0, 0);
  }
  expect(virtualizer.itemSizeCache.get("retained")).toBe(160);
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
    measureElement: measureTranscriptRow,
  });
  const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = virtualizer;
  onTestFinished(mountVirtualizer());
  updateVirtualizer();
  virtualizer.getVirtualItems();
  const readViewport = vi.fn(() => 300);
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: readViewport });
  const refs = new TranscriptRowRefs(virtualizer, {
    isCurrentRow: (row) => viewport.contains(row),
    beforeMeasure: () => {},
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
  expect([readHeight.mock.calls, readViewport.mock.calls]).toEqual([[], []]);
  expect(mounted.every((row) => observedElements.has(row))).toBe(true);
  for (const observer of resizeObservers) {
    for (const row of mounted) {
      observer.emitTarget(row, 800, height);
    }
  }
  expect([...virtualizer.itemSizeCache.values()]).toEqual(indexes.map(() => 80));
  expect(readHeight).not.toHaveBeenCalled();
});
