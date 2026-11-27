import { elementScroll, Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import {
  observeTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { TranscriptReaderAnchor } from "./chat-transcript-reader-anchor.ts";

it("keeps native zero when a prepared predecessor lands its first measurement", () => {
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText = "height:400px;width:400px;overflow:auto;overflow-anchor:none";
  onTestFinished(() => viewport.remove());
  const content = viewport.appendChild(document.createElement("div"));
  content.style.cssText = "height:1000px;position:relative";
  const column = content.appendChild(document.createElement("div"));
  column.style.cssText = "position:absolute;top:200px;width:400px";
  const retained = column.appendChild(document.createElement("div"));
  retained.style.height = "200px";
  retained.dataset.index = retained.dataset.virtualRowKey = "1";
  const prepared = content.appendChild(document.createElement("div"));
  prepared.style.cssText = "position:absolute;top:0;width:400px;height:280px;visibility:hidden";
  prepared.dataset.index = prepared.dataset.virtualRowKey = "0";
  prepared.dataset.preparedRow = prepared.dataset.preparingRow = "true";
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 5,
    estimateSize: () => 200,
    getItemKey: String,
    getScrollElement: () => viewport,
    initialRect: { width: 400, height: 400 },
    initialOffset: 0,
    overscan: 1,
    scrollToFn: elementScroll,
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = viewport;
  virtualizer.targetWindow = window;
  virtualizer.elementsCache.set("0", prepared);
  virtualizer.elementsCache.set("1", retained);
  const anchor = new TranscriptReaderAnchor(
    {
      virtualizer,
      layout: new TranscriptLayoutOwner(() => {}),
      offsetState: new TranscriptOffsetState(),
      renderer: { columnElement: column, queueAfterCommit: () => {} },
      initialRange: { pending: false },
      prependAnchor: new TranscriptPrependAnchor(
        new Map(),
        () => {},
        () => false,
      ),
      headerHeight: 0,
      scrollElement: viewport,
      contentElement: content,
    },
    () => {},
  );
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = anchor.landSize;
  virtualizer.setOptions({ ...virtualizer.options, onChange: () => anchor.flush() });

  expect(virtualizer.getTotalSize()).toBe(1000);
  virtualizer.resizeItem(0, prepared.getBoundingClientRect().height);

  expect(virtualizer.getTotalSize()).toBe(1080);
  expect(viewport.scrollTop).toBe(0);
});

it("preserves a near-end reader when a deferred measurement shrinks the native range", () => {
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText = "height:400px;width:400px;overflow:auto;overflow-anchor:none";
  const content = viewport.appendChild(document.createElement("div"));
  content.style.position = "relative";
  const column = content.appendChild(document.createElement("div"));
  column.style.cssText = "position:absolute;top:1080px;width:400px";
  const retained = column.appendChild(document.createElement("div"));
  retained.style.height = "80px";
  retained.dataset.index = "9";
  retained.dataset.virtualRowKey = "9";
  const prepared = content.appendChild(document.createElement("div"));
  prepared.style.cssText = "position:absolute;top:0;height:80px;width:400px";
  prepared.dataset.index = "0";
  prepared.dataset.virtualRowKey = "0";
  prepared.dataset.preparedRow = "true";
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 10,
    estimateSize: () => 120,
    getItemKey: String,
    getScrollElement: () => viewport,
    initialRect: { width: 400, height: 400 },
    initialOffset: 796,
    overscan: 1,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = viewport;
  virtualizer.targetWindow = window;
  virtualizer.elementsCache.set("0", prepared);
  virtualizer.elementsCache.set("9", retained);
  const layout = new TranscriptLayoutOwner(() => {});
  layout.commitRange(content, virtualizer.getTotalSize());
  viewport.scrollTop = 796;
  const anchor = new TranscriptReaderAnchor(
    {
      virtualizer,
      layout,
      offsetState: new TranscriptOffsetState(),
      renderer: { columnElement: column, queueAfterCommit: () => {} },
      initialRange: { pending: false },
      prependAnchor: new TranscriptPrependAnchor(
        new Map(),
        () => {},
        () => false,
      ),
      headerHeight: 0,
      scrollElement: viewport,
      contentElement: content,
    },
    () => {},
  );
  onTestFinished(() => viewport.remove());
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = anchor.landSize;
  const distanceFromEnd = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  expect(distanceFromEnd()).toBe(4);

  virtualizer.resizeItem(0, prepared.offsetHeight);
  anchor.flush();

  expect(viewport.scrollHeight).toBe(1160);
  expect(distanceFromEnd()).toBe(4);
});

const predecessorMeasurementPhases = [
  "settled",
  "scrolling",
  "touch-after-prepend",
  "touch-at-start",
  "home-at-start",
  "idle-gap",
  "start",
  "start-growth",
  "programmatic",
] as const;

it.each(predecessorMeasurementPhases)(
  "reconciles first predecessor measurements while %s",
  async (phase) => {
    const atStart = phase === "touch-at-start" || phase === "home-at-start";
    const estimate = phase === "start-growth" || atStart ? 60 : 120;
    const offset = phase.startsWith("start") ? 0 : atStart ? 200 : 500;
    const viewport = document.body.appendChild(document.createElement("div"));
    viewport.style.cssText = "height:400px;width:400px;overflow:auto;overflow-anchor:none";
    const content = viewport.appendChild(document.createElement("div"));
    content.style.cssText = "height:12000px;position:relative";
    const column = content.appendChild(document.createElement("div"));
    column.style.cssText = `position:absolute;top:${offset + 2 * estimate}px;width:400px`;
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
      estimateSize: () => estimate,
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
    offsetState.nativeInputActive = phase !== "settled" && phase !== "programmatic";
    offsetState.touching = phase === "touch-at-start";
    const prependAnchor = new TranscriptPrependAnchor(
      new Map([["2", retained]]),
      () => {},
      () => false,
    );
    if (phase === "touch-after-prepend") {
      retained.dataset.messageId = "2";
      prependAnchor.messageKeys = new Set(["2"]);
      prependAnchor.capture(viewport, false);
      prependAnchor.messageKeys = new Set(["older", "2"]);
      prependAnchor.capture(viewport, false);
      offsetState.touching = true;
      expect(prependAnchor.messageKey).toBe("2");
    }
    const anchor = new TranscriptReaderAnchor(
      {
        virtualizer,
        layout: new TranscriptLayoutOwner(() => {}),
        offsetState,
        renderer: { columnElement: column, queueAfterCommit: () => {} },
        initialRange: { pending: false },
        prependAnchor,
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
    virtualizer.isScrolling = phase !== "settled";
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
    if (phase.startsWith("start")) {
      expect(viewport.scrollTop).toBe(0);
      expect(column.style.marginTop).toBe("");
      expect(predecessors[0]!.getBoundingClientRect().top).toBe(
        viewport.getBoundingClientRect().top,
      );
      return;
    }
    expect(measuredTop).toBe(top);
    if (phase === "home-at-start") {
      onTestFinished(
        observeTranscriptOffset(
          {
            state: offsetState,
            getScrollElement: () => viewport,
            prependAnchor,
            endAnchor: new TranscriptEndAnchor(() => {}),
            canFollowEnd: () => false,
            isProgrammaticScroll: () => false,
            cancelScroll: () => {},
            onLayoutCorrection: () => {},
            invalidate: () => {},
            onOffset: () => {},
            onReaderScroll: () => {},
            onComposerLayout: () => {},
          },
          virtualizer,
          (observedOffset, scrolling) => {
            virtualizer.scrollOffset = observedOffset;
            virtualizer.isScrolling = scrolling;
          },
        ),
      );
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    }
    if (atStart) {
      expect(column.style.marginTop).toBe("-40px");
      viewport.scrollTop = 0;
      const beforeSettle = retained.getBoundingClientRect().top;
      expect(beforeSettle).toBeLessThan(viewport.getBoundingClientRect().bottom);
      anchor.settle();
      expect(retained.getBoundingClientRect().top).toBe(beforeSettle);
      offsetState.touching = false;
      offsetState.nativeInputActive = false;
      virtualizer.isScrolling = false;
      anchor.settle();
      if (phase === "home-at-start") {
        expect(viewport.scrollTop).toBe(0);
      } else {
        expect(retained.getBoundingClientRect().top).toBe(beforeSettle);
        expect(viewport.scrollTop).toBe(40);
      }
      expect(column.style.marginTop).toBe("");
    } else if (phase === "scrolling") {
      expect(viewport.scrollTop).toBe(500);
      viewport.scrollTop = 40;
      anchor.settle();
      expect(viewport.scrollTop).toBe(0);
      expect(column.style.marginTop).toBe("");
    } else if (phase === "idle-gap") {
      // Virtual-core's debounce lapses between two frames of a slow native smooth scroll. The
      // input's own scrolling continues, so a write here would cancel it.
      virtualizer.isScrolling = false;
      anchor.settle();
      expect(viewport.scrollTop).toBe(500);
      expect(column.style.marginTop).not.toBe("");
      // The input's own idle arrives after virtual-core's idle flush; the next frame settles.
      offsetState.nativeInputActive = false;
      const frame = Promise.withResolvers<number>();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
      expect(viewport.scrollTop).toBe(420);
      expect(column.style.marginTop).toBe("");
    } else if (phase === "programmatic") {
      expect(viewport.scrollTop).toBe(420);
    }
  },
);

// Scrolling up fast: a row prepared outside the flow joins it together with a newly mounted row
// estimated far taller than it renders, both above the text the reader sees.
it("keeps visible rows still when a prepared row joins the flow beside a new row", async () => {
  const estimate = 240;
  const offset = 5 * estimate + 100;
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText = "height:600px;width:400px;overflow:auto;overflow-anchor:none";
  const content = viewport.appendChild(document.createElement("div"));
  content.style.cssText = "height:12000px;position:relative";
  const column = content.appendChild(document.createElement("div"));
  const row = (index: number, height: number) => {
    const element = document.createElement("div");
    element.style.height = `${height}px`;
    element.dataset.index = String(index);
    element.dataset.virtualRowKey = String(index);
    return element;
  };
  // Row 7 is the text the reader sees, 400px below the top edge.
  const columnTop = offset + 400;
  column.style.cssText = `position:absolute;top:${columnTop}px;width:400px`;
  const visible = column.appendChild(row(7, 35));
  // Row 5 is measured while prepared off to the side, outside the flow.
  const prepared = content.appendChild(row(5, 34));
  prepared.dataset.preparedRow = "true";
  prepared.dataset.preparingRow = "true";
  prepared.style.cssText += ";position:absolute;top:0;width:400px;visibility:hidden";
  viewport.scrollTop = offset;
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 100,
    estimateSize: () => estimate,
    getItemKey: String,
    getScrollElement: () => viewport,
    initialRect: { width: 400, height: 600 },
    initialOffset: offset,
    overscan: 1,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = viewport;
  virtualizer.targetWindow = window;
  virtualizer.elementsCache.set("5", prepared);
  virtualizer.elementsCache.set("7", visible);
  const anchor = new TranscriptReaderAnchor(
    {
      virtualizer,
      layout: new TranscriptLayoutOwner(() => {}),
      offsetState: new TranscriptOffsetState(),
      renderer: { columnElement: column, queueAfterCommit: () => {} },
      initialRange: { pending: false },
      prependAnchor: new TranscriptPrependAnchor(
        new Map(),
        () => {},
        () => false,
      ),
      headerHeight: 0,
      scrollElement: viewport,
      contentElement: content,
    },
    () => {},
  );
  const observed = [prepared, visible];
  onTestFinished(() => {
    observed.forEach((element) => anchor.unobserve(element));
    viewport.remove();
  });
  const delivered = (element: HTMLElement) =>
    new Promise<void>((resolve) => {
      const ready = new ResizeObserver(() => {
        ready.disconnect();
        resolve();
      });
      onTestFinished(() => ready.disconnect());
      ready.observe(element);
    });
  anchor.observe(prepared);
  anchor.observe(visible);
  await delivered(visible);
  const before = visible.getBoundingClientRect().top;

  // The prepared row joins the flow and row 6 mounts between it and the reader. The column starts
  // at row 5's virtual start, which counts row 6 at its estimate.
  delete prepared.dataset.preparedRow;
  delete prepared.dataset.preparingRow;
  prepared.style.cssText = "height:34px";
  const mounted = row(6, 34);
  observed.push(mounted);
  column.prepend(prepared, mounted);
  column.style.top = `${columnTop - 34 - estimate}px`;
  virtualizer.elementsCache.set("6", mounted);
  anchor.observe(mounted);
  await delivered(mounted);

  expect(visible.getBoundingClientRect().top).toBe(before);
});

it("keeps a new predecessor stable after another row's owned measurement", async () => {
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText = "height:400px;width:400px;overflow:auto;overflow-anchor:none";
  const content = viewport.appendChild(document.createElement("div"));
  content.style.cssText = "height:12000px;position:relative";
  const column = content.appendChild(document.createElement("div"));
  column.style.cssText = "position:absolute;top:400px;width:400px";
  const row = (index: number, height: number) => {
    const element = document.createElement("div");
    element.style.height = `${height}px`;
    element.dataset.index = String(index);
    element.dataset.virtualRowKey = String(index);
    return element;
  };
  const owned = column.appendChild(row(1, 150));
  const retained = column.appendChild(row(2, 80));
  viewport.scrollTop = 500;
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 100,
    estimateSize: () => 120,
    getItemKey: String,
    getScrollElement: () => viewport,
    initialRect: { width: 400, height: 400 },
    initialOffset: 500,
    scrollMargin: 280,
    overscan: 1,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = viewport;
  virtualizer.targetWindow = window;
  virtualizer.elementsCache.set("1", owned);
  virtualizer.elementsCache.set("2", retained);
  virtualizer.resizeItem(1, owned.offsetHeight);
  retained.dataset.messageId = "2";
  const prependAnchor = new TranscriptPrependAnchor(
    new Map([["2", retained]]),
    () => {},
    () => false,
  );
  prependAnchor.messageKeys = new Set(["2"]);
  const anchor = new TranscriptReaderAnchor(
    {
      virtualizer,
      layout: new TranscriptLayoutOwner(() => {}),
      offsetState: new TranscriptOffsetState(),
      renderer: { columnElement: column, queueAfterCommit: () => {} },
      initialRange: { pending: false },
      prependAnchor,
      headerHeight: 0,
      scrollElement: viewport,
      contentElement: content,
    },
    () => {},
  );
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = anchor.landSize;
  const rows = [owned, retained];
  onTestFinished(() => {
    rows.forEach((element) => anchor.unobserve(element));
    viewport.remove();
  });
  rows.forEach((element) => anchor.observe(element));
  await new Promise<void>((resolve) => {
    const ready = new ResizeObserver(() => {
      ready.disconnect();
      resolve();
    });
    onTestFinished(() => ready.disconnect());
    ready.observe(retained);
  });
  const top = retained.getBoundingClientRect().top;
  // The positioning owner measures and restores this row before native delivery.
  prependAnchor.capture(viewport, false, true);
  const previousHeight = owned.offsetHeight;
  owned.style.height = "210px";
  virtualizer.resizeItem(1, owned.offsetHeight);
  viewport.scrollTop += owned.offsetHeight - previousHeight;
  prependAnchor.clear();

  const predecessor = row(0, 80);
  rows.push(predecessor);
  const measured = new Promise<number>((resolve) => {
    const ready = new ResizeObserver(() => {
      ready.disconnect();
      resolve(retained.getBoundingClientRect().top);
    });
    onTestFinished(() => ready.disconnect());
    virtualizer.elementsCache.set("0", predecessor);
    anchor.observe(predecessor);
    ready.observe(predecessor);
  });
  column.prepend(predecessor);
  column.style.top = "280px";
  expect(await measured).toBe(top);
});
