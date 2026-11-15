import { defaultRangeExtractor, Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { commitTranscriptRows } from "./chat-transcript-header.ts";

function fixture() {
  const viewport = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => viewport.remove());
  const estimateSize = vi.fn(() => 100);
  const keys = Array.from({ length: 100 }, (_, index) => String(index));
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: keys.length,
    getItemKey: (index) => keys[index]!,
    estimateSize,
    getScrollElement: () => viewport,
    initialRect: { width: 800, height: 300 },
    initialOffset: 550,
    anchorTo: "end",
    scrollEndThreshold: -1,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  virtualizer.scrollElement = viewport;
  virtualizer.getVirtualItems();
  return { virtualizer, estimateSize, keys };
}

it("keeps the same visible key and within-row offset through prepend and trim with a header change", () => {
  const { virtualizer, keys } = fixture();
  const prepended = ["new-0", "new-1", ...keys];
  commitTranscriptRows(virtualizer, prepended, 20, defaultRangeExtractor);
  expect(virtualizer.scrollOffset).toBe(770);
  expect(virtualizer.getVirtualItemForOffset(770)?.key).toBe("5");

  commitTranscriptRows(virtualizer, prepended.slice(3), -20, defaultRangeExtractor);
  expect(virtualizer.scrollOffset).toBe(450);
  expect(virtualizer.getVirtualItemForOffset(450)?.key).toBe("5");
});

it("records successive measurements without rebuilding the unmeasured transcript between them", () => {
  const { virtualizer, keys, estimateSize } = fixture();
  commitTranscriptRows(virtualizer, keys, 0, defaultRangeExtractor);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  estimateSize.mockClear();
  virtualizer.resizeItem(1, 80);
  virtualizer.resizeItem(2, 90);
  virtualizer.resizeItem(3, 110);
  expect(estimateSize).not.toHaveBeenCalled();
  expect(virtualizer.itemSizeCache.get("2")).toBe(90);
  expect(virtualizer.getTotalSize()).toBe(9980);
});
