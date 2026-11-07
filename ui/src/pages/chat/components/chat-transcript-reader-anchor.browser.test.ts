import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { TranscriptReaderAnchor } from "./chat-transcript-reader-anchor.ts";

it.each(["settled", "scrolling", "start", "programmatic"] as const)(
  "reconciles first predecessor measurements while %s",
  async (phase) => {
    const scrolling = phase !== "settled";
    const offset = phase === "start" ? 0 : 500;
    const viewport = document.body.appendChild(document.createElement("div"));
    viewport.style.cssText = "height:400px;width:400px;overflow:auto;overflow-anchor:none";
    const content = viewport.appendChild(document.createElement("div"));
    content.style.cssText = "height:12000px;position:relative";
    const column = content.appendChild(document.createElement("div"));
    column.style.cssText = `position:absolute;top:${offset + 240}px;width:400px`;
    const row = (index: number) => {
      const element = document.createElement("div");
      element.style.height = "80px";
      element.dataset.index = String(index);
      element.dataset.virtualRowKey = String(index);
      return element;
    };
    const retained = column.appendChild(row(2));
    viewport.scrollTop = offset;
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 100,
      estimateSize: () => 120,
      getItemKey: String,
      getScrollElement: () => viewport,
      initialRect: { width: 400, height: 400 },
      initialOffset: offset,
      scrollMargin: offset,
      overscan: 1,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn(),
    });
    virtualizer.scrollElement = viewport;
    virtualizer.targetWindow = window;
    virtualizer.elementsCache.set("2", retained);
    const offsetState = new TranscriptOffsetState();
    offsetState.nativeInputActive = scrolling && phase !== "programmatic";
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
    const rows = [retained];
    onTestFinished(() => {
      rows.forEach((element) => anchor.unobserve(element));
      viewport.remove();
    });
    anchor.observe(retained);
    await new Promise<void>((resolve) => {
      const ready = new ResizeObserver(() => {
        ready.disconnect();
        resolve();
      });
      onTestFinished(() => ready.disconnect());
      ready.observe(retained);
    });
    const top = retained.getBoundingClientRect().top;
    virtualizer.isScrolling = scrolling;
    const predecessors = [row(0), row(1)];
    rows.push(...predecessors);
    const measured = new Promise<number>((resolve) => {
      const ready = new ResizeObserver(() => {
        ready.disconnect();
        resolve(retained.getBoundingClientRect().top);
      });
      onTestFinished(() => ready.disconnect());
      predecessors.forEach((element) => {
        virtualizer.elementsCache.set(element.dataset.index!, element);
        anchor.observe(element);
      });
      ready.observe(predecessors[1]!);
    });
    column.prepend(...predecessors);
    column.style.top = `${offset}px`;
    const measuredTop = await measured;
    if (phase === "start") {
      expect(viewport.scrollTop).toBe(0);
      expect(column.style.marginTop).toBe("");
      expect(predecessors[0]!.getBoundingClientRect().top).toBe(
        viewport.getBoundingClientRect().top,
      );
      return;
    }
    expect(measuredTop).toBe(top);
    if (scrolling && phase !== "programmatic") {
      expect(viewport.scrollTop).toBe(500);
      viewport.scrollTop = 40;
      anchor.settle();
      expect(viewport.scrollTop).toBe(0);
      expect(column.style.marginTop).toBe("");
    } else if (phase === "programmatic") {
      expect(viewport.scrollTop).toBe(420);
    }
  },
);
