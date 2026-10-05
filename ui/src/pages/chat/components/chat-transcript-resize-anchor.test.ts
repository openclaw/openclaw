/* @vitest-environment jsdom */
import type { VirtualItem, Virtualizer } from "@tanstack/virtual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptResizeAnchor } from "./chat-transcript-resize-anchor.ts";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function at(element: Element, top: () => number) {
  (element as HTMLElement).getBoundingClientRect = () => ({ top: top() }) as DOMRect;
}

/** A row that crosses the viewport top, with the reader on its second paragraph. */
function fixture({ oldIOS }: { oldIOS: boolean }) {
  if (oldIOS) {
    vi.stubGlobal("navigator", { userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
    vi.stubGlobal("CSS", { supports: () => false });
  }
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.scrollTop = 1000;
  at(scroller, () => 0);
  const content = scroller.appendChild(document.createElement("div"));
  content.className = "chat-thread-inner";
  const row = content.appendChild(document.createElement("div"));
  row.dataset.virtualRowKey = "row";
  row.innerHTML = '<div class="chat-bubble" data-message-id="m"><p>cut</p><p>read</p></div>';
  const [cut, read] = row.querySelectorAll("p");
  let growth = 0;
  at(row, () => -200);
  at(row.firstElementChild!, () => -190);
  at(cut!, () => -150);
  at(read!, () => 50 + growth);
  const writes: number[] = [];
  let touching = false;
  const anchor = new TranscriptResizeAnchor({
    hasScrollCommand: () => false,
    interactionRow: () => null,
    touching: () => touching,
    writeOffset: (offset) => writes.push(offset),
  });
  const instance = {
    scrollOffset: 1000,
    scrollAdjustments: 0,
    scrollElement: scroller,
    isScrolling: true,
    itemSizeCache: new Map([["row", 500]]),
    elementsCache: new Map([["row", row]]),
    options: { count: 5 },
  } as unknown as Virtualizer<HTMLDivElement, HTMLElement>;
  anchor.observeRow(row);
  const item = { key: "row", index: 1, start: 800, end: 1300, size: 500, lane: 0 } as VirtualItem;
  // The cut paragraph grows by 40 px above the reader; the row grows by 100 px in total.
  const resize = () => {
    growth = 40;
    return anchor.shouldAdjust(item, 100, instance);
  };
  return {
    anchor,
    content,
    instance,
    resize,
    scroller,
    writes,
    setTouching: (value: boolean) => (touching = value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("transcript resize anchor", () => {
  it("shifts by the part of a spanning row that grew above the reader", () => {
    const { resize, writes } = fixture({ oldIOS: false });

    expect(resize()).toBe(false);
    expect(writes).toEqual([1040]);
  });

  it("holds a shift on screen during an old iOS fling and folds it into scrollTop at rest", () => {
    const { anchor, content, instance, resize, writes, setTouching } = fixture({ oldIOS: true });
    setTouching(true);

    // Writing scrollTop would stop the fling, so the rows move up instead.
    expect(resize()).toBe(false);
    expect(writes).toEqual([]);
    expect(content.style.translate).toBe("0 -40px");
    expect(anchor.readerOffset(1000)).toBe(1040);

    instance.isScrolling = false;
    anchor.settle(instance);
    expect(writes).toEqual([]);

    setTouching(false);
    anchor.settle(instance);
    expect(writes).toEqual([1040]);
  });

  it("keeps a held shift that points above the first row until there is room", () => {
    const { anchor, content, instance, scroller, writes } = fixture({ oldIOS: true });
    // A row above the reader comes in 60 px shorter than its estimate.
    instance.itemSizeCache.delete("row");
    const item = { key: "row", index: 0, start: 0, end: 500, size: 500, lane: 0 } as VirtualItem;
    anchor.shouldAdjust(item, -60, instance);
    expect(content.style.translate).toBe("0 60px");

    scroller.scrollTop = 20;
    instance.isScrolling = false;
    anchor.settle(instance);
    expect(writes).toEqual([]);

    scroller.scrollTop = 300;
    anchor.settle(instance);
    expect(writes).toEqual([240]);
  });
});
