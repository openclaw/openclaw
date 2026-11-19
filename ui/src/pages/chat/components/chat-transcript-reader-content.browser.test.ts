import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { TranscriptReaderAnchor } from "./chat-transcript-reader-anchor.ts";

function nextResize(element: Element): Promise<void> {
  return new Promise((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve();
    });
    onTestFinished(() => observer.disconnect());
    observer.observe(element);
  });
}

// A preview image that loads late inside the message crossing the reader's top edge.
it.each([
  // [case, scrollTop, where the image lands, reader text displacement, final scrollTop]
  ["above the reader's text", 400, "prepend", 0, 560],
  ["above the reader's text at the row's top", 360, "prepend", 0, 520],
  // A scroll event can read the grown layout before its resize delivery.
  ["above the reader's text while scrolling", 400, "prepend", 0, 400],
  ["below the reader's text", 400, "append", 0, 400],
  ["at the transcript start", 0, "prepend", 160, 0],
] as const)(
  "keeps the reader's text still when a visible row grows %s",
  async (phase, offset, insert, displacement, scrollTop) => {
    const viewport = document.body.appendChild(document.createElement("div"));
    viewport.style.cssText = "height:350px;width:300px;overflow:auto;overflow-anchor:none";
    const content = viewport.appendChild(document.createElement("div"));
    content.style.cssText = "height:6000px;position:relative";
    const column = content.appendChild(document.createElement("div"));
    column.style.cssText = "position:absolute;top:0;width:300px";
    const rows = Array.from({ length: 8 }, (_, index) => {
      const row = column.appendChild(document.createElement("div"));
      row.dataset.index = String(index);
      row.dataset.virtualRowKey = String(index);
      const text = row.appendChild(document.createElement("p"));
      text.style.cssText = "margin:0;height:120px";
      text.textContent = `Synthetic message ${index}`;
      return row;
    });
    viewport.scrollTop = offset;
    const scrolling = phase.endsWith("while scrolling");
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: rows.length,
      estimateSize: () => 120,
      getItemKey: String,
      getScrollElement: () => viewport,
      initialRect: { width: 300, height: 350 },
      initialOffset: offset,
      overscan: 1,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn(),
    });
    virtualizer.scrollElement = viewport;
    virtualizer.targetWindow = window;
    rows.forEach((row, index) => virtualizer.elementsCache.set(String(index), row));
    virtualizer.isScrolling = scrolling;
    const offsetState = new TranscriptOffsetState();
    offsetState.nativeInputActive = scrolling;
    const anchor = new TranscriptReaderAnchor(
      {
        virtualizer,
        layout: new TranscriptLayoutOwner(() => {}),
        offsetState,
        renderer: { columnElement: column, queueAfterCommit: () => {} },
        initialRange: { pending: false },
        prependAnchor: { messageKey: null },
        headerHeight: 0,
        scrollElement: viewport,
        contentElement: content,
      },
      () => {},
    );
    onTestFinished(() => {
      rows.forEach((row) => anchor.unobserve(row));
      viewport.remove();
    });
    // The anchor's observer exists first, so its delivery precedes each wait.
    rows.forEach((row) => anchor.observe(row));
    const measured = nextResize(rows.at(-1)!);
    await measured;
    const row = rows[Math.floor(offset / 120)]!;
    const text = row.firstElementChild!;
    const before = text.getBoundingClientRect().top;
    const grown = nextResize(row);
    const image = document.createElement("div");
    image.style.height = "160px";
    row[insert](image);
    if (scrolling) {
      anchor.captureReaderContent();
    }
    await grown;
    expect(text.getBoundingClientRect().top - before).toBe(displacement);
    expect(viewport.scrollTop).toBe(scrollTop);
  },
);
