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

  it.each(["cached", "overscan"])(
    "avoids layout reads for %s row mounts while scrolling",
    async (kind) => {
      const { rows, virtualizer, refs, readViewport, cleanup } = mountRows();
      const indexes = kind === "cached" ? [0, 1, 2] : [6, 7, 8];
      try {
        for (const index of indexes) {
          if (kind === "cached") {
            virtualizer.resizeItem(index, 80);
          }
          refs.forKey(String(index))(rows[index]);
        }
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(readViewport).not.toHaveBeenCalled();
        for (const index of indexes) {
          expect(observedElements.has(expectDefined(rows[index], "mounted row"))).toBe(true);
        }
      } finally {
        cleanup();
      }
    },
  );

  it.each([false, true])("lets observers measure cold rows (scrolling=%s)", async (scrolling) => {
    const { rows, virtualizer, refs, readViewport, cleanup } = mountRows(scrolling);
    const readHeight = vi.fn(() => 80);
    for (const row of rows.slice(0, 3)) {
      Object.defineProperty(row, "offsetHeight", { configurable: true, get: readHeight });
    }
    try {
      for (let index = 0; index < 3; index++) {
        refs.forKey(String(index))(rows[index]);
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(readHeight).not.toHaveBeenCalled();
      expect(readViewport).not.toHaveBeenCalled();
      expect(rows.slice(0, 3).every((row) => observedElements.has(row))).toBe(true);
      for (const observer of resizeObservers) {
        for (const row of rows.slice(0, 3)) {
          observer.emitTarget(row, 800, 80);
        }
      }
      expect([...virtualizer.itemSizeCache.values()]).toEqual([80, 80, 80]);
      expect(readHeight).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("waits for preview clamps on rows mounted in a later microtask", async () => {
    const { rows, virtualizer, refs, cleanup } = mountRows();
    const secondRow = expectDefined(rows[1], "second row");
    let height = 160;
    Object.defineProperty(secondRow, "offsetHeight", { configurable: true, get: () => height });
    try {
      refs.forKey("0")(rows[0]);
      queueMicrotask(() => {
        refs.forKey("1")(secondRow);
        queueMicrotask(() => {
          height = 80;
        });
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      for (const observer of resizeObservers) {
        observer.emitTarget(secondRow, 800, height);
      }
      expect(virtualizer.itemSizeCache.get("1")).toBe(80);
      expect(observedElements.has(secondRow)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
