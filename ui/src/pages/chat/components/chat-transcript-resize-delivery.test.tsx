/* @vitest-environment jsdom */

import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { contentRows, emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import { readConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { TranscriptReaderAnchor } from "./chat-transcript-reader-anchor.ts";
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
    expect(row.style.getPropertyValue("contain-intrinsic-block-size")).toBe(
      streaming ? "" : "180px",
    );
    if (streaming) {
      expect(row.style.contentVisibility).toBe("visible");
      renderRows(rows.map((item) => Object.assign({}, item, { streaming: false })));
      await flushDeferredRowPrune();
      expect(row.style.getPropertyValue("contain-intrinsic-block-size")).toBe("180px");
    }
    expect(transcriptSize(container)).toBe(180);
  },
);

it("defers replacement rows when resize delivery reads a pending native jump", async () => {
  const frame = stubAnimationFrames();
  const rows = contentRows(80);
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
    const prepend = new TranscriptPrependAnchor(new Map([["reader", bubble]]), () => {});
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
    const reader = new TranscriptReaderAnchor({
      virtualizer,
      layout: new TranscriptLayoutOwner(() => {}),
      offsetState,
      renderer: { columnElement: column },
      initialRange: { pending: false },
      prependAnchor: prepend,
      headerHeight: 0,
      scrollElement: scroller,
      contentElement: null,
    });
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
      prepend.restoreBookmark(
        { messageKey: "reader", rowKey: "row:2", offset: before - 100 },
        scroller,
      );
      rows[0]!.style.height = "120px";
      const separateRow = kind === "mixed" || kind === "footprint";
      // Persisted widget minima can reach the virtual cache before the DOM applies them.
      if (kind === "footprint") {
        virtualizer.resizeItem(1, 140);
      }
      const measure = () =>
        readConnectedTranscriptRows(
          scroller,
          virtualizer,
          separateRow ? rows.slice(0, 1) : rows,
          reader.recordOwnedMeasurement,
        )?.() ?? false;
      prepend.update(scroller, virtualizer, measure);
      prepend.update(scroller, virtualizer, measure);
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
