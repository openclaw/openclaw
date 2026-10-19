/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  isTranscriptProgrammaticScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
  TranscriptOffsetState,
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
  const messageElements = new Map([["visible", bubble]]);
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
    messageElements,
    anchor: new TranscriptPrependAnchor(messageElements),
    measureRows: vi.fn(() => false),
  };
}

const messages = (...ids: string[]) => new Set(ids);
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("transcript prepend anchor", () => {
  it("settles a reachable anchor when the browser ignores its scroll command", () => {
    const { scroller, bubble, virtualizer, instance, anchor, measureRows } = fixture();
    anchor.messageKeys = messages("visible");
    anchor.capture(scroller, false);
    scroller.scrollTop = 200;
    anchor.messageKeys = messages("older", "visible");
    anchor.capture(scroller, false);
    bubble.getBoundingClientRect = () => rect(130, 180);
    virtualizer.scrollToOffset.mockImplementation(() => {});
    anchor.update(scroller, instance, measureRows);
    anchor.update(scroller, instance, measureRows);
    expect(anchor.messageKey).toBeNull();
    expect(anchor.update(scroller, instance, measureRows)).toBe(false);
    expect(scroller.scrollTop).toBe(200);
  });

  it("retains an asynchronous scroll target until the next frame commits it", () => {
    const { scroller, bubble, virtualizer, instance, anchor, measureRows } = fixture();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    anchor.messageKeys = messages("visible");
    anchor.capture(scroller, false);
    scroller.scrollTop = 200;
    anchor.messageKeys = messages("older", "visible");
    anchor.capture(scroller, false);
    bubble.getBoundingClientRect = () => rect(330 - scroller.scrollTop, 180);
    virtualizer.scrollToOffset.mockImplementation((offset) => {
      frames.push(() => {
        scroller.scrollTop = offset;
      });
    });
    const reconcile = vi.fn(() => anchor.update(scroller, instance, measureRows));
    anchor.update(scroller, instance, measureRows);
    anchor.scheduleReconcile(reconcile);
    expect(anchor.messageKey).toBe("visible");
    expect(reconcile).not.toHaveBeenCalled();
    // Measurement notifications can commit again before WebKit applies scrolling.
    expect(anchor.update(scroller, instance, measureRows)).toBe(false);
    expect(anchor.messageKey).toBe("visible");
    expect(virtualizer.scrollToOffset).toHaveBeenCalledOnce();
    for (const frame of frames.splice(0)) {
      frame(0);
    }
    expect(scroller.scrollTop).toBe(240);
    expect(anchor.messageKey).toBeNull();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it.each([0, 1])(
    "preserves the reader through deferred native scrolling with %spx rounding and later wheel input",
    (rounding) => {
      vi.useFakeTimers();
      const { scroller, bubble, anchor, measureRows } = fixture(2000);
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrameId = 0;
      let frameTime = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        const id = ++nextFrameId;
        frames.set(id, callback);
        return id;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      const commitFrame = () => {
        frameTime += 16;
        for (const id of Array.from(frames.keys())) {
          const callback = frames.get(id);
          frames.delete(id);
          callback?.(frameTime);
        }
      };
      let contentTop = 290;
      let deferNativeScroll = false;
      bubble.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, 180);
      scroller.scrollTop = 200;
      scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
        const target =
          typeof options === "number" ? (y ?? 0) : (options?.top ?? scroller.scrollTop);
        const write = () => {
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.max(
            0,
            Math.min(target - (deferNativeScroll ? rounding : 0), 1500),
          );
          if (scroller.scrollTop !== before) {
            scroller.dispatchEvent(new Event("scroll"));
          }
        };
        if (deferNativeScroll) {
          requestAnimationFrame(write);
        } else {
          write();
        }
      };
      const state = new TranscriptOffsetState();
      const owner = {
        state,
        getScrollElement: () => scroller,
        prependAnchor: anchor,
        endAnchor: new TranscriptEndAnchor(),
        canFollowEnd: () => false,
        isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, scroller),
        cancelScroll: () => anchor.clear(),
        onLayoutCorrection: vi.fn(),
        invalidate: vi.fn(),
        onOffset: vi.fn(() => false),
        onReaderScroll: vi.fn(),
        onComposerLayout: vi.fn(),
      };
      const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
        count: 1,
        estimateSize: () => 2000,
        initialOffset: 200,
        getScrollElement: () => scroller,
        observeElementRect: (_, callback) => callback({ width: 800, height: 500 }),
        observeElementOffset: (virtualizer, callback) =>
          observeTranscriptOffset(owner, virtualizer, callback),
        scrollToFn: (offset, options, virtualizer) =>
          scrollTranscriptOffset(state, offset, options, virtualizer),
      });
      const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = instance;
      const dispose = mountVirtualizer();
      updateVirtualizer();
      try {
        anchor.messageKeys = messages("visible");
        anchor.capture(scroller, false);
        anchor.messageKeys = messages("older", "visible");
        anchor.capture(scroller, false);
        contentTop += 40;
        deferNativeScroll = true;
        const reconcile = () => {
          if (anchor.update(scroller, instance, measureRows)) {
            state.syncNativeOffset?.();
            anchor.scheduleReconcile(reconcile);
          }
        };
        reconcile();
        expect(scroller.scrollTop).toBe(200);
        for (let frame = 0; frame < 6; frame += 1) {
          commitFrame();
        }
        expect(scroller.scrollTop).toBe(240 - rounding);
        expect(bubble.getBoundingClientRect().top).toBe(90 + rounding);
        expect(anchor.messageKey).toBeNull();

        // A new projection can still yield to actual reader intent after
        // programmatic restoration; maintenance provenance cannot lock the reader.
        anchor.capture(scroller, false, true);
        expect(anchor.messageKey).toBe("visible");
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
        scroller.scrollTop -= 20;
        scroller.dispatchEvent(new Event("scroll"));
        expect(anchor.update(scroller, instance, measureRows)).toBe(false);
        expect(anchor.messageKey).toBeNull();
        expect(scroller.scrollTop).toBe(220 - rounding);
        expect(bubble.getBoundingClientRect().top).toBe(110 + rounding);
      } finally {
        anchor.clear();
        dispose();
        vi.useRealTimers();
      }
    },
  );

  it("preserves a partially visible retained message rather than overscan across measurement and DOM replacement", () => {
    const { scroller, row, bubble, messageElements, virtualizer, instance, anchor, measureRows } =
      fixture();
    const overscan = document.createElement("div");
    overscan.className = "chat-bubble";
    overscan.dataset.messageId = "above";
    overscan.getBoundingClientRect = () => rect(-200, 100);
    row.prepend(overscan);
    messageElements.set("above", overscan);
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
    messageElements.set("visible", committed);
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

  it("anchors the first visible current message in DOM order after later refs prepend", () => {
    const { scroller, row, messageElements, anchor, instance, measureRows } = fixture();
    const first = document.createElement("div");
    first.className = "chat-bubble";
    first.dataset.messageId = "acknowledged";
    let top = 110;
    first.getBoundingClientRect = () => rect(top, 80);
    row.prepend(first);
    messageElements.set("optimistic", first);
    const outside = document.createElement("div");
    scroller.before(outside);
    outside.dataset.messageId = "outside";
    outside.getBoundingClientRect = () => rect(100, 80);
    messageElements.set("outside", outside);
    anchor.messageKeys = messages("outside", "acknowledged", "visible");
    anchor.capture(scroller, false);
    anchor.messageKeys = messages("older", "outside", "acknowledged", "visible");
    anchor.capture(scroller, false);
    expect(anchor.messageKey).toBe("acknowledged");
    scroller.scrollTop = 200;
    top = 150;
    anchor.update(scroller, instance, measureRows);
    expect(scroller.scrollTop).toBe(240);
  });

  it.each<[string, string[], string[], boolean, number?, number?, boolean?]>([
    ["start boundary", ["visible"], ["older", "visible"], true, 0, 50],
    ["end boundary", ["visible"], ["older", "visible"], true, 1100, 130],
    ["stable bubble", ["visible"], ["older", "visible"], true, 200, 90],
    ["removed bubble", ["visible"], ["older", "visible"], true, 200, 90, true],
    ["startup", [], ["visible"], false],
    ["append", ["visible"], ["visible", "new"], false],
    ["replacement", ["visible"], ["replacement"], false],
    ["trimming", ["removed", "visible"], ["visible"], false],
  ])(
    "settles %s without a scroll write",
    (_name, previous, next, restoring, offset = 200, top = 90, removed = false) => {
      const { scroller, bubble, instance, anchor, measureRows } = fixture();
      anchor.messageKeys = messages(...previous);
      anchor.capture(scroller, false);
      anchor.messageKeys = messages(...next);
      anchor.capture(scroller, false);
      scroller.scrollTop = offset;
      bubble.getBoundingClientRect = () => rect(top, 180);
      expect(anchor.update(scroller, instance, measureRows)).toBe(restoring);
      if (removed) {
        bubble.remove();
      }
      expect(anchor.update(scroller, instance, measureRows)).toBe(restoring);
      expect(anchor.messageKey).toBeNull();
      expect(scroller.scrollTop).toBe(offset);
      expect(anchor.update(scroller, instance, measureRows)).toBe(false);
      if (!restoring) {
        expect(measureRows).not.toHaveBeenCalled();
      }
    },
  );

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
      state: new TranscriptOffsetState(),
      getScrollElement: () => scroller,
      prependAnchor: anchor,
      endAnchor: new TranscriptEndAnchor(),
      canFollowEnd: () => true,
      isProgrammaticScroll: () => false,
      cancelScroll: () => anchor.clear(),
      onLayoutCorrection: vi.fn(),
      invalidate: vi.fn(),
      onOffset: vi.fn(() => false),
      onReaderScroll: vi.fn(),
      onComposerLayout: vi.fn(),
    };
    const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
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
    });
    const { _didMount: mountVirtualizer, _willUpdate: updateVirtualizer } = instance;
    const dispose = mountVirtualizer();
    updateVirtualizer();
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
      dispose();
    }
  });
});
