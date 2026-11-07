/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  observeTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";

const rect = (top: number, height: number) => new DOMRect(0, top, 800, height);
const measuredRows = () => true;
const unmeasuredRows = () => false;

function fixture(scrollHeight = 1600) {
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.getBoundingClientRect = () => rect(100, 500);
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
  scroller.innerHTML =
    '<div class="chat-virtual-row" data-index="4"><div class="chat-bubble" data-message-id="visible"></div></div>';
  const row = scroller.firstElementChild as HTMLElement;
  const bubble = row.firstElementChild as HTMLElement;
  const messageElements = new Map([["visible", bubble]]);
  const measureRows = vi.fn(() => false);
  bubble.getBoundingClientRect = () => rect(90, 180);
  const virtualizer = {
    scrollElement: scroller,
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
    measureRows,
    anchor: new TranscriptPrependAnchor(messageElements, vi.fn(), measureRows),
  };
}

const messages = (...ids: string[]) => new Set(ids);
afterEach(() => document.body.replaceChildren());

it("stops requesting commits when a reachable scroll correction makes no progress", () => {
  const { scroller, bubble, virtualizer, instance, anchor } = fixture();
  scroller.scrollTop = 200;
  anchor.messageKeys = messages("visible");
  anchor.capture(scroller, false);
  anchor.messageKeys = messages("older", "visible");
  anchor.capture(scroller, false);
  bubble.getBoundingClientRect = () => rect(130, 180);
  // Model a native scroll command ignored until layout is available.
  virtualizer.scrollToOffset.mockImplementation(() => {});

  const commits = Array.from({ length: 3 }, () => anchor.update(instance, measuredRows));
  expect(commits).toEqual([true, true, false]);
  expect(anchor.messageKey).toBeNull();
  expect(scroller.scrollTop).toBe(200);
});

it.each([true, false])(
  "preserves only an existing end anchor through measured prepend correction (%s)",
  (following) => {
    const { scroller, bubble, instance, messageElements } = fixture();
    const endAnchor = new TranscriptEndAnchor(() => {});
    const anchor = new TranscriptPrependAnchor(
      messageElements,
      (before, after) => endAnchor.recordLayoutCorrection(before, after),
      () => false,
    );
    let height = 1600;
    Object.defineProperty(scroller, "scrollHeight", { get: () => height });
    scroller.scrollTop = 1100;
    bubble.getBoundingClientRect = () => rect(1190 - scroller.scrollTop, 180);
    anchor.messageKeys = messages("visible");
    anchor.capture(scroller, false);
    anchor.messageKeys = messages("older", "visible");
    anchor.capture(scroller, false);
    if (following) {
      endAnchor.capture(scroller);
    }

    // A shrinking range clamps the old end; a later measured prepend restores its message.
    height = 1583;
    scroller.scrollTop = 1083;
    endAnchor.recordLayoutCorrection(1100, 1083);
    height = 1631;
    anchor.update(instance, measuredRows);
    expect(scroller.scrollTop).toBe(1100);
    const follow = vi.fn();
    endAnchor.reconcile(scroller, true, false, follow);
    expect(follow).toHaveBeenCalledTimes(following ? 1 : 0);
  },
);

it("preserves a partially visible retained message rather than overscan across measurement and DOM replacement", () => {
  const { scroller, row, bubble, messageElements, virtualizer, instance, anchor } = fixture();
  const overscan = document.createElement("div");
  overscan.className = "chat-bubble";
  overscan.dataset.messageId = "above";
  overscan.getBoundingClientRect = () => rect(-200, 100);
  row.prepend(overscan);
  messageElements.set("above", overscan);
  const prepared = document.createElement("div");
  prepared.className = "chat-virtual-row";
  prepared.dataset.preparedRow = "true";
  const cached = document.createElement("div");
  cached.dataset.messageId = "cached";
  cached.getBoundingClientRect = () => {
    throw new Error("Prepend must not force layout of a prepared offscreen row");
  };
  prepared.append(cached);
  scroller.prepend(prepared);
  messageElements.set("cached", cached);
  anchor.messageKeys = messages("above", "visible");
  anchor.capture(scroller, false);
  anchor.messageKeys = messages("above", "visible", "peer");
  anchor.capture(scroller, false, true);
  scroller.scrollTop = 200;
  bubble.getBoundingClientRect = () => rect(130, 180);
  expect(anchor.update(instance, unmeasuredRows)).toBe(false);
  expect(scroller.scrollTop).toBe(200);
  bubble.getBoundingClientRect = () => rect(90, 180);
  expect(anchor.update(instance, measuredRows)).toBe(true);
  expect(scroller.scrollTop).toBe(200);
  const committed = bubble.cloneNode() as HTMLElement;
  let contentTop = 590;
  committed.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, 180);
  bubble.replaceWith(committed);
  messageElements.set("visible", committed);
  expect(anchor.update(instance, measuredRows)).toBe(true);
  expect(scroller.scrollTop).toBe(500);
  expect(virtualizer.scrollOffset).toBe(200);
  expect(virtualizer.scrollToOffset).toHaveBeenCalledWith(500, { behavior: "instant" });
  // The first correction can mount more rows above the reader on the next commit.
  contentTop += 80;
  expect(anchor.update(instance, measuredRows)).toBe(true);
  expect(scroller.scrollTop).toBe(580);
  expect(anchor.update(instance, measuredRows)).toBe(true);
  expect(anchor.update(instance, measuredRows)).toBe(false);
});

it("anchors the first visible current message in DOM order after later refs prepend", () => {
  const { scroller, row, messageElements, anchor, instance } = fixture();
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
  anchor.update(instance, measuredRows);
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
    const { scroller, bubble, instance, anchor } = fixture();
    anchor.messageKeys = messages(...previous);
    anchor.capture(scroller, false);
    anchor.messageKeys = messages(...next);
    anchor.capture(scroller, false);
    scroller.scrollTop = offset;
    bubble.getBoundingClientRect = () => rect(top, 180);
    expect(anchor.update(instance, measuredRows)).toBe(restoring);
    if (removed) {
      bubble.remove();
    }
    expect(anchor.update(instance, measuredRows)).toBe(restoring);
    expect(anchor.messageKey).toBeNull();
    expect(scroller.scrollTop).toBe(offset);
    expect(anchor.update(instance, measuredRows)).toBe(false);
  },
);

it("retires a reader anchor when an explicit scroll command replaces it", () => {
  const { scroller, instance, anchor } = fixture();
  anchor.messageKeys = messages("visible");
  anchor.capture(scroller, false);
  anchor.messageKeys = messages("older", "visible");
  anchor.capture(scroller, false);
  expect(anchor.messageKey).toBe("visible");

  anchor.messageKeys = messages("older", "visible", "sent");
  anchor.capture(scroller, true, true);
  expect(anchor.messageKey).toBeNull();
  expect(anchor.update(instance, measuredRows)).toBe(false);
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
  anchor.update(instance, measuredRows);
  expect(measureRows).not.toHaveBeenCalled();
  contentTop += 30;
  anchor.messageKeys = messages("older", "visible", "peer-one", "peer-two");
  anchor.capture(scroller, false, true);
  anchor.update(instance, unmeasuredRows);
  contentTop += 30;
  anchor.messageKeys = messages("older", "visible", "peer-one", "peer-two", "peer-three");
  anchor.capture(scroller, false, true);
  anchor.update(instance, unmeasuredRows);
  expect(scroller.scrollTop).toBe(260);
  expect(bubble.getBoundingClientRect().top).toBe(90);
  expect(measureRows).toHaveBeenCalledTimes(2);
});

it("preserves native wheel movement after a projection captures the reader", () => {
  const { scroller, bubble, anchor } = fixture(2000);
  let headerGrowth = 0;
  bubble.getBoundingClientRect = () => rect(290 + headerGrowth - scroller.scrollTop, 180);
  const owner = {
    state: new TranscriptOffsetState(),
    getScrollElement: () => scroller,
    prependAnchor: anchor,
    endAnchor: new TranscriptEndAnchor(() => {}),
    canFollowEnd: () => true,
    isProgrammaticScroll: () => false,
    isMaintenanceScroll: () => false,
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
    anchor.update(instance, measuredRows);
    headerGrowth = 30;
    scroller.scrollTop = 160;
    scroller.dispatchEvent(new Event("scroll"));
    anchor.update(instance, measuredRows);
    expect(scroller.scrollTop).toBe(190);
    expect(bubble.getBoundingClientRect().top).toBe(130);
  } finally {
    dispose();
  }
});

it("restores the same message offset after its cached window and row geometry change", () => {
  const { scroller, bubble, messageElements, instance, measureRows } = fixture(2400);
  let contentTop = 275;
  bubble.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, 180);
  scroller.scrollTop = 200;
  const original = new TranscriptPrependAnchor(messageElements, vi.fn());
  original.messageKeys = messages("visible");
  const bookmark = original.bookmark(scroller)!;
  expect(bookmark.offset).toBe(-25);
  // A fresh owner sees a trimmed/reloaded window with different preceding height.
  contentTop = 900;
  scroller.scrollTop = 420;
  const restored = new TranscriptPrependAnchor(messageElements, vi.fn());
  restored.messageKeys = messages("visible");
  restored.restoreBookmark(bookmark, scroller);
  restored.update(scroller, instance, measureRows);
  expect(scroller.scrollTop).toBe(825);
  expect(bubble.getBoundingClientRect().top - scroller.getBoundingClientRect().top).toBe(-25);
});
