/* @vitest-environment jsdom */

import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { contentRows, emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import { readConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { TranscriptReaderAnchor } from "./chat-transcript-reader-anchor.ts";
import type { TranscriptNativeScroll } from "./chat-transcript-scroll-events.ts";
import { createTranscriptPresentation } from "./chat-transcript-session.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  transcriptSize,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([false, true])(
  "defers row resizes without reflecting live geometry (streaming=%s)",
  async (streaming) => {
    const frame = stubAnimationFrames();
    const rows = contentRows(1);
    for (const row of rows) {
      row.streaming = streaming;
    }
    const onViewportResize = vi.fn();
    const transcript = createChatTranscript(() => "resize-delivery", { onViewportResize });
    const { container, renderRows } = await mountTestTranscript(
      "resize-delivery",
      rows,
      transcript,
    );
    frame();
    await flushDeferredRowPrune();
    renderRows(rows);
    emitTranscriptResize(container, 800, 600);
    onViewportResize.mockClear();
    emitTranscriptResize(container, 800, 500);
    expect(onViewportResize).toHaveBeenCalledOnce();
    const row = requireElement(container, ".chat-virtual-row");
    const before = transcriptSize(container);

    row.style.height = "180px";
    emitTranscriptResize(row, 800, 180);
    // A microtask commit still runs inside the browser's resize delivery cycle.
    await flushDeferredRowPrune();
    expect(transcriptSize(container)).toBe(before);

    frame();
    await flushDeferredRowPrune();
    expect(row.dataset.rowSize).toBe(streaming ? undefined : "180");
    expect(row.style.getPropertyValue("contain-intrinsic-block-size")).toBe("");
    if (streaming) {
      expect(row.style.contentVisibility).toBe("visible");
      renderRows(rows.map((item) => Object.assign({}, item, { streaming: false })));
      await flushDeferredRowPrune();
      expect(row.dataset.rowSize).toBe("180");
    }
    expect(transcriptSize(container)).toBe(180);
  },
);

it("defers replacement rows when resize delivery reads a pending native jump", async () => {
  const frame = stubAnimationFrames();
  // The native fixture is 100px; unmeasured rows must describe the same geometry.
  const rows = contentRows(80).map((row) => Object.assign({}, row, { estimatedSize: 100 }));
  const { container, renderRows } = await mountTestTranscript("resize-native-jump", rows);
  frame();
  await flushDeferredRowPrune();
  renderRows(rows);
  container.scrollTop = 800;
  container.dispatchEvent(new Event("scroll"));
  frame();
  await flushDeferredRowPrune();
  const before = transcriptRows(container);
  const outgoing = before[0]!;
  expect(before.length).toBeLessThan(rows.length);
  expect(container.querySelector('.chat-virtual-row[data-index="40"]')).toBeNull();

  // Native scrolling can advance before its scroll event. The outgoing row's
  // observer must not replace its own observed subtree during delivery.
  container.scrollTop = 4000;
  emitTranscriptResize(outgoing, 800, 120);
  expect(transcriptRows(container)).toEqual(before);
  await flushDeferredRowPrune();
  expect(transcriptRows(container)).toEqual(before);

  frame();
  await flushDeferredRowPrune();
  expect(container.scrollTop).toBe(4000);
  expect(container.querySelector('.chat-virtual-row[data-index="40"]')).not.toBeNull();
});

it("flushes a measured native jump before forwarding its captured scroll policy", async () => {
  const frame = stubAnimationFrames();
  const rows = contentRows(80).map((row) => Object.assign({}, row, { estimatedSize: 100 }));
  const onNativeScroll = vi.fn<(scroll: TranscriptNativeScroll) => void>();
  const transcript = createChatTranscript(() => "resize-native-policy", { onNativeScroll });
  const { container, renderRows } = await mountTestTranscript(
    "resize-native-policy",
    rows,
    transcript,
  );
  frame();
  await flushDeferredRowPrune();
  renderRows(rows);
  container.scrollTop = 800;
  container.dispatchEvent(new Event("scroll"));
  frame();
  await flushDeferredRowPrune();
  const before = transcriptRows(container);
  const outgoing = before[0]!;
  container.scrollTop = 4000;
  emitTranscriptResize(outgoing, 800, 120);
  await flushDeferredRowPrune();
  expect(transcriptRows(container)).toEqual(before);

  const commit = vi.fn();
  onTestFinished(transcript.subscribe(commit));
  onNativeScroll.mockClear();
  const forwarded: Array<{ offset: number; commits: number }> = [];
  onNativeScroll.mockImplementation((scroll) => {
    forwarded.push({
      offset: scroll.viewport.scrollTop,
      commits: commit.mock.calls.length,
    });
  });
  container.dispatchEvent(new Event("scroll"));
  expect(onNativeScroll).toHaveBeenCalledOnce();
  // This branch notifies the pane before policy; its subscriber owns the batched DOM commit.
  expect(forwarded).toEqual([{ offset: 4000, commits: 1 }]);
  frame();
  await flushDeferredRowPrune();
  expect(container.scrollTop).toBe(4000);
  expect(container.querySelector('.chat-virtual-row[data-index="40"]')).not.toBeNull();
});

it.each(["flushChange", "cancelChange", "disconnect"] as const)(
  "retires the coalesced row commit on %s before its queued frame",
  (action) => {
    const frame = stubAnimationFrames();
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 0,
      getScrollElement: () => null,
      estimateSize: () => 100,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn(),
    });
    const presentation = createTranscriptPresentation(
      () => null,
      virtualizer,
      () => [],
      vi.fn(),
    );
    const superseded = vi.fn();
    const latest = vi.fn();
    presentation.commitChange(superseded, true);
    presentation.commitChange(latest, true);
    presentation[action]();
    expect(superseded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(action === "flushChange" ? 1 : 0);
    frame();
    expect(superseded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(action === "flushChange" ? 1 : 0);
    presentation.disconnect();
  },
);

it.each([
  { kind: "accounted", lateChange: 0, deliveredChange: 0 },
  { kind: "stale", lateChange: 0, deliveredChange: -9 },
  { kind: "shrink", lateChange: -9, deliveredChange: -9 },
  { kind: "expand", lateChange: 9, deliveredChange: 9 },
  { kind: "mixed", lateChange: -9, deliveredChange: -9 },
  { kind: "footprint", lateChange: 40, deliveredChange: 40 },
  { kind: "hidden", lateChange: -9, deliveredChange: -9 },
  { kind: "touch", lateChange: 9, deliveredChange: 9 },
])(
  "keeps native geometry through prepend handoff ($kind)",
  ({ kind, lateChange, deliveredChange }) => {
    const frame = stubAnimationFrames();
    const scroller = document.body.appendChild(document.createElement("div"));
    const column = scroller.appendChild(document.createElement("div"));
    const offsetState = new TranscriptOffsetState();
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 2000 },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 800, 100);
    scroller.scrollTop = 250;
    scroller.scrollTo = (options?: ScrollToOptions | number) => {
      scroller.scrollTop = typeof options === "object" ? (options.top ?? 0) : (options ?? 0);
    };
    let visible = true;
    const rows = Array.from({ length: 3 }, (_, index) => {
      const row = column.appendChild(document.createElement("div"));
      row.style.height = "100px";
      row.dataset.index = String(index);
      row.dataset.virtualRowKey = `row:${index}`;
      row.getBoundingClientRect = () => {
        const above = rows
          .slice(0, index)
          .reduce((sum, prior) => sum + Number.parseFloat(prior.style.height), 0);
        return new DOMRect(
          0,
          100 + above - scroller.scrollTop + (Number.parseFloat(column.style.marginTop) || 0),
          visible ? 800 : 0,
          Number.parseFloat(row.style.height),
        );
      };
      return row;
    });
    const bubble = rows[2]!;
    bubble.dataset.messageId = "reader";
    const afterCommit = new Set<() => void>();
    const separateRow = kind === "mixed" || kind === "footprint";
    const measure = () =>
      readConnectedTranscriptRows(
        scroller,
        virtualizer,
        separateRow ? rows.slice(0, 1) : rows,
        reader.recordOwnedMeasurement,
      )?.() ?? false;
    const prepend = new TranscriptPrependAnchor(new Map([["reader", bubble]]), () => {}, measure);
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: rows.length,
      initialOffset: 250,
      estimateSize: () => 100,
      // This handoff exercises independent changes in both mounted predecessors.
      overscan: 2,
      getItemKey: (index) => `row:${index}`,
      getScrollElement: () => scroller,
      observeElementRect: (_, callback) => callback({ width: 800, height: 100 }),
      observeElementOffset: (_, callback) => callback(scroller.scrollTop, false),
      measureElement: (row) => Number.parseFloat(row.style.height),
      useAnimationFrameWithResizeObserver: true,
      scrollToFn: (offset, { adjustments = 0 }) => {
        scroller.scrollTop = offset + adjustments;
      },
      onChange: () => reader.flush(),
    });
    const reconcile = (): void => {
      prepend.update(virtualizer, reader.rowsMeasured);
    };
    const reader = new TranscriptReaderAnchor(
      {
        virtualizer,
        layout: new TranscriptLayoutOwner(() => {}),
        offsetState,
        renderer: {
          columnElement: column,
          queueAfterCommit: (effect) => void afterCommit.add(effect),
        },
        initialRange: { pending: false },
        prependAnchor: prepend,
        headerHeight: 0,
        scrollElement: scroller,
        contentElement: null,
      },
      reconcile,
    );
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = reader.landSize;
    const { _didMount: mount, _willUpdate: update } = virtualizer;
    const dispose = mount();
    update();
    try {
      // Every observed row belongs to this fixture's accepted physical range.
      expect(virtualizer.getVirtualItems().map((item) => item.index)).toEqual([0, 1, 2]);
      for (const row of rows) {
        reader.observe(row);
        virtualizer.measureElement(row);
        emitTranscriptResize(row, 800, 100);
      }
      frame();
      const before = bubble.getBoundingClientRect().top;
      prepend.messageKeys = new Set(["reader"]);
      prepend.capture(scroller, false);
      prepend.restoreBookmark(
        { messageKey: "reader", rowKey: "row:2", offset: before - 100 },
        scroller,
      );
      // The saved target becomes a real prefix handoff, not a warm replacement.
      prepend.messageKeys = new Set(["older", "reader"]);
      prepend.capture(scroller, false);
      rows[0]!.style.height = "120px";
      // Persisted widget minima can reach the virtual cache before the DOM applies them.
      if (kind === "footprint") {
        virtualizer.resizeItem(1, 140);
      }
      // An unchanged native receipt schedules the stable after-commit pass without
      // acknowledging row 0 before foreground measurement owns its current height.
      emitTranscriptResize(bubble, 800, 100);
      reconcile();
      if (kind === "footprint") {
        expect(reader.rowsMeasured()).toBe(false);
      }
      for (const effect of [...afterCommit]) {
        afterCommit.delete(effect);
        effect();
      }
      expect(prepend.messageKey).toBeNull();
      expect(bubble.getBoundingClientRect().top).toBe(before);

      const nativeOffset = scroller.scrollTop;
      if (kind === "touch") {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
        offsetState.touching = true;
      }

      const changedRow = rows[separateRow ? 1 : 0]!;
      const baseHeight = separateRow ? 100 : 120;
      if (kind === "hidden") {
        visible = false;
        changedRow.style.height = "0px";
        // A stale visible entry must not replace a currently hidden row's last height.
        emitTranscriptResize(changedRow, 800, baseHeight);
        visible = true;
      }
      changedRow.style.height = `${baseHeight + lateChange}px`;
      // A queued observer snapshot can predate the foreground native measurement.
      emitTranscriptResize(changedRow, kind === "hidden" ? 0 : 800, baseHeight + deliveredChange);
      const delivered = bubble.getBoundingClientRect().top;
      frame();
      emitTranscriptResize(changedRow, 800, baseHeight + lateChange);
      frame();
      const virtualDelivered = bubble.getBoundingClientRect().top;
      expect({ delivered, virtualDelivered }).toEqual({
        delivered: before,
        virtualDelivered: before,
      });
      if (kind === "touch") {
        expect(scroller.scrollTop).toBe(nativeOffset);
        expect(column.style.marginTop).toBe("-9px");
        offsetState.touching = false;
        reader.settle();
        expect(column.style.marginTop).toBe("");
        expect(bubble.getBoundingClientRect().top).toBe(before);
      }
    } finally {
      for (const row of rows) {
        reader.unobserve(row);
      }
      dispose();
    }
  },
);
