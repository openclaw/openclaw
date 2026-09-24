/* @vitest-environment jsdom */
import { VirtualizerController } from "@tanstack/lit-virtual";
import type { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTranscriptOffsetState,
  observeTranscriptOffset,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    width: 800,
    left: 0,
    right: 800,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function fixture(scrollHeight = 1600) {
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.getBoundingClientRect = () => rect(100, 500);
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 },
    scrollHeight: { value: scrollHeight },
  });
  scroller.innerHTML =
    '<div class="chat-virtual-row" data-index="4"><div class="chat-bubble" data-message-id="visible"></div></div>';
  const row = scroller.firstElementChild as HTMLElement;
  const bubble = row.firstElementChild as HTMLElement;
  bubble.getBoundingClientRect = () => rect(90, 180);
  const virtualizer = {
    scrollToOffset: vi.fn((offset: number) => {
      scroller.scrollTop = Math.max(0, Math.min(offset, scrollHeight - scroller.clientHeight));
    }),
    scrollOffset: 200,
  };
  return {
    scroller,
    row,
    bubble,
    virtualizer,
    instance: virtualizer as unknown as Virtualizer<HTMLDivElement, HTMLElement>,
    anchor: new TranscriptPrependAnchor(),
    measureRows: vi.fn(() => false),
  };
}

const messages = (...ids: string[]) => new Set(ids);
afterEach(() => document.body.replaceChildren());

describe("transcript prepend anchor", () => {
  it("preserves a partially visible retained message rather than overscan across measurement and DOM replacement", () => {
    const { scroller, row, bubble, virtualizer, instance, anchor, measureRows } = fixture();
    const overscan = document.createElement("div");
    overscan.className = "chat-bubble";
    overscan.dataset.messageId = "above";
    overscan.getBoundingClientRect = () => rect(-200, 100);
    row.prepend(overscan);
    anchor.messageKeys = messages("above", "visible");
    anchor.capture(scroller, false);
    anchor.messageKeys = messages("older", "above", "visible");
    anchor.capture(scroller, false);
    scroller.scrollTop = 200;
    expect(anchor.update(scroller, instance, measureRows)).toBe(true);
    expect(measureRows).toHaveBeenCalledOnce();
    expect(scroller.scrollTop).toBe(200);
    const committed = bubble.cloneNode() as HTMLElement;
    let contentTop = 590;
    committed.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, 180);
    bubble.replaceWith(committed);
    expect(anchor.update(scroller, instance, measureRows)).toBe(true);
    expect(scroller.scrollTop).toBe(500);
    expect(virtualizer.scrollOffset).toBe(200);
    expect(virtualizer.scrollToOffset).toHaveBeenCalledWith(500, { behavior: "instant" });
    // The first correction can mount more rows above the reader on the next commit.
    contentTop += 80;
    measureRows.mockReturnValueOnce(true);
    const corrected = anchor.update(scroller, instance, measureRows);
    expect(scroller.scrollTop).toBe(580);
    expect(corrected).toBe(true);
    expect(anchor.update(scroller, instance, measureRows)).toBe(true);
    expect(anchor.update(scroller, instance, measureRows)).toBe(false);
  });

  it.each([
    { offset: 0, top: 50 },
    { offset: 1100, top: 130 },
  ])("settles an unreachable message anchor at scroll boundary $offset", ({ offset, top }) => {
    const { scroller, bubble, instance, anchor, measureRows } = fixture();
    anchor.messageKeys = messages("visible");
    anchor.capture(scroller, false);
    anchor.messageKeys = messages("older", "visible");
    anchor.capture(scroller, false);
    scroller.scrollTop = offset;
    bubble.getBoundingClientRect = () => rect(top, 180);
    anchor.update(scroller, instance, measureRows);
    anchor.update(scroller, instance, measureRows);
    expect(anchor.messageKey).toBeNull();
    expect(scroller.scrollTop).toBe(offset);
    expect(anchor.update(scroller, instance, measureRows)).toBe(false);
  });

  it.each([
    [messages(), messages("visible")],
    [messages("visible"), messages("visible", "new")],
    [messages("visible"), messages("replacement")],
    [messages("removed", "visible"), messages("visible")],
  ])("does not restore startup, append, replacement, or trimming", (previous, next) => {
    const { scroller, instance, anchor, measureRows } = fixture();
    anchor.messageKeys = previous;
    anchor.capture(scroller, false);
    anchor.messageKeys = next;
    anchor.capture(scroller, false);
    expect(anchor.update(scroller, instance, measureRows)).toBe(false);
    expect(measureRows).not.toHaveBeenCalled();
  });

  it("keeps the original reader target when another projection commits before restoration", () => {
    const { scroller, bubble, instance, anchor, measureRows } = fixture();
    let contentTop = 290;
    bubble.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, 180);
    anchor.messageKeys = messages("visible");
    anchor.capture(scroller, false);
    scroller.scrollTop = 200;
    anchor.messageKeys = messages("visible", "peer-one");
    anchor.capture(scroller, false, true);
    anchor.update(scroller, instance, measureRows);
    contentTop += 30;
    anchor.messageKeys = messages("visible", "peer-one", "peer-two");
    anchor.capture(scroller, false, true);
    anchor.update(scroller, instance, measureRows);
    contentTop += 30;
    anchor.update(scroller, instance, measureRows);
    expect(scroller.scrollTop).toBe(260);
    expect(bubble.getBoundingClientRect().top).toBe(90);
  });

  it("preserves native wheel movement after a projection captures the reader", () => {
    const { scroller, bubble, anchor, measureRows } = fixture(2000);
    let headerGrowth = 0;
    bubble.getBoundingClientRect = () => rect(290 + headerGrowth - scroller.scrollTop, 180);
    const owner = {
      state: createTranscriptOffsetState(),
      getScrollElement: () => scroller,
      prependAnchor: anchor,
      isProgrammaticScroll: () => false,
      cancelScroll: () => anchor.clear(),
      requestUpdate: vi.fn(),
      onReaderScroll: vi.fn(),
      onComposerInput: vi.fn(),
      onComposerLayout: vi.fn(),
      cancelComposerResize: vi.fn(),
    };
    const controller = new VirtualizerController<HTMLDivElement, HTMLElement>(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      {
        count: 1,
        estimateSize: () => 2000,
        initialOffset: 200,
        getScrollElement: () => scroller,
        observeElementRect: (_, callback) => {
          callback({ width: 800, height: 500 });
        },
        observeElementOffset: (virtualizer, callback) =>
          observeTranscriptOffset(owner, virtualizer, callback),
        scrollToFn: (offset) => {
          scroller.scrollTop = offset;
        },
      },
    );
    const instance = controller.getVirtualizer();
    controller.hostConnected();
    controller.hostUpdated();
    scroller.dispatchEvent(new Event("scroll"));
    try {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      anchor.messageKeys = messages("visible");
      anchor.capture(scroller, false, true);
      anchor.update(scroller, instance, measureRows);
      headerGrowth = 30;
      scroller.scrollTop = 160;
      scroller.dispatchEvent(new Event("scroll"));
      anchor.update(scroller, instance, measureRows);
      expect(scroller.scrollTop).toBe(190);
      expect(bubble.getBoundingClientRect().top).toBe(130);
    } finally {
      controller.hostDisconnected();
    }
  });

  it.each([false, true])(
    "retires restoration without a write when the bubble is stable or removed=$removed",
    (removed) => {
      const { scroller, bubble, instance, anchor, measureRows } = fixture();
      anchor.messageKeys = messages("visible");
      anchor.capture(scroller, false);
      anchor.messageKeys = messages("older", "visible");
      anchor.capture(scroller, false);
      anchor.update(scroller, instance, measureRows);
      if (removed) {
        bubble.remove();
      }
      scroller.scrollTop = 200;
      expect(anchor.update(scroller, instance, measureRows)).toBe(true);
      expect(scroller.scrollTop).toBe(200);
      expect(anchor.update(scroller, instance, measureRows)).toBe(false);
    },
  );
});
