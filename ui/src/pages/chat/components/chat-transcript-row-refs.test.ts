/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureTranscriptRow } from "./chat-transcript-geometry.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import {
  installTranscriptDomMocks,
  observedElements,
  resetTranscriptTestDom,
  resizeObservers,
} from "./chat-transcript.test-support.ts";

function mountRows(scrolling = true) {
  const viewport = document.body.appendChild(document.createElement("div"));
  const rows = Array.from({ length: 12 }, (_, index) => {
    const row = viewport.appendChild(document.createElement("div"));
    row.dataset.index = String(index);
    row.dataset.virtualRowKey = String(index);
    return row;
  });
  const controller = new VirtualizerController<HTMLDivElement, HTMLElement>(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    },
    {
      count: rows.length,
      getScrollElement: () => viewport,
      getItemKey: (index) => String(index),
      estimateSize: () => 100,
      observeElementRect: (_, callback) => {
        callback({ width: 800, height: 300 });
      },
      observeElementOffset: (_, callback) => {
        callback(0, scrolling);
      },
      scrollToFn: vi.fn(),
      measureElement: measureTranscriptRow,
    },
  );
  controller.hostConnected();
  controller.hostUpdated();
  const virtualizer = controller.getVirtualizer();
  const cleanup = () => controller.hostDisconnected();
  virtualizer.getVirtualItems();
  const readViewport = vi.fn(() => 300);
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: readViewport });
  const refs = new TranscriptRowRefs(virtualizer, {
    isCurrentRow: (row) => viewport.contains(row),
    onMount: () => {},
  });
  return { rows, virtualizer, refs, readViewport, cleanup };
}

describe("transcript mounted-row measurement", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([
    { kind: "cached", scrolling: true, indexes: [0, 1, 2] },
    { kind: "overscan", scrolling: true, indexes: [6, 7, 8] },
    { kind: "cold idle", scrolling: false, indexes: [0, 1, 2] },
    { kind: "cold scrolling", scrolling: true, indexes: [0, 1, 2] },
    { kind: "later microtask", scrolling: true, indexes: [0, 1], deferred: true },
  ])(
    "defers $kind row measurement to observers without layout reads",
    async ({ kind, scrolling, indexes, deferred }) => {
      const { rows, virtualizer, refs, readViewport, cleanup } = mountRows(scrolling);
      const mounted = indexes.map((index) => expectDefined(rows[index], "mounted row"));
      let height = deferred ? 160 : 80;
      const readHeight = vi.fn(() => height);
      try {
        for (const [position, index] of indexes.entries()) {
          const row = mounted[position]!;
          Object.defineProperty(row, "offsetHeight", { configurable: true, get: readHeight });
          if (kind === "cached") {
            virtualizer.resizeItem(index, 80);
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
        expect(readHeight).not.toHaveBeenCalled();
        expect(readViewport).not.toHaveBeenCalled();
        expect(mounted.every((row) => observedElements.has(row))).toBe(true);
        for (const observer of resizeObservers) {
          for (const row of mounted) {
            observer.emitTarget(row, 800, height);
          }
        }
        expect([...virtualizer.itemSizeCache.values()]).toEqual(indexes.map(() => 80));
        expect(readHeight).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    },
  );
});
