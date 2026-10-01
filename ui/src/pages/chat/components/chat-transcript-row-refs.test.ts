/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  observedElements,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

function mountRows() {
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
        callback(0, true);
      },
      scrollToFn: vi.fn(),
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
    canMeasureVisibleRows: () => true,
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
        await flushDeferredRowPrune();
        expect(readViewport).not.toHaveBeenCalled();
        for (const index of indexes) {
          expect(observedElements.has(expectDefined(rows[index], "mounted row"))).toBe(true);
        }
      } finally {
        cleanup();
      }
    },
  );

  it("reads cold visible rows without intervening style or scroll writes", async () => {
    const { rows, virtualizer, refs, readViewport, cleanup } = mountRows();
    const operations: string[] = [];
    const firstRow = expectDefined(rows[0], "first row");
    const secondRow = expectDefined(rows[1], "second row");
    secondRow.style.setProperty("content-visibility", "auto", "important");
    for (const row of rows.slice(0, 3)) {
      const setProperty = row.style.setProperty.bind(row.style);
      const removeProperty = row.style.removeProperty.bind(row.style);
      vi.spyOn(row.style, "setProperty").mockImplementation((...args) => {
        operations.push("write");
        setProperty(...args);
      });
      vi.spyOn(row.style, "removeProperty").mockImplementation((...args) => {
        operations.push("write");
        return removeProperty(...args);
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        get: () => {
          operations.push("read");
          return 80;
        },
      });
    }
    virtualizer.setOptions({
      ...virtualizer.options,
      onChange: () => operations.push("notify"),
    });
    try {
      for (let index = 0; index < 3; index++) {
        refs.forKey(String(index))(rows[index]);
      }
      await flushDeferredRowPrune();
      const firstRead = operations.indexOf("read");
      const lastRead = operations.lastIndexOf("read");
      expect(operations.slice(firstRead, lastRead + 1)).toEqual(["read", "read", "read"]);
      expect(readViewport).toHaveBeenCalledOnce();
      expect([...virtualizer.itemSizeCache.values()]).toEqual([80, 80, 80]);
      expect(firstRow.style.getPropertyValue("content-visibility")).toBe("");
      expect(secondRow.style.getPropertyValue("content-visibility")).toBe("auto");
      expect(secondRow.style.getPropertyPriority("content-visibility")).toBe("important");
      expect(rows.slice(0, 3).every((row) => observedElements.has(row))).toBe(true);
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
      await flushDeferredRowPrune();
      expect(virtualizer.itemSizeCache.get("1")).toBe(80);
      expect(observedElements.has(secondRow)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
