/* @vitest-environment jsdom */
import type { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function fixture() {
  const scroller = document.body.appendChild(document.createElement("div"));
  scroller.getBoundingClientRect = () => rect(100, 500);
  scroller.innerHTML =
    '<div class="chat-virtual-row" data-index="4"><div class="chat-bubble" data-message-id="visible"></div></div>';
  const row = scroller.firstElementChild as HTMLElement;
  const bubble = row.firstElementChild as HTMLElement;
  bubble.getBoundingClientRect = () => rect(90, 180);
  const virtualizer = {
    scrollToOffset: vi.fn((offset: number) => {
      scroller.scrollTop = offset;
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
    measureRows: vi.fn(),
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
    committed.getBoundingClientRect = () => rect(390, 180);
    bubble.replaceWith(committed);
    expect(anchor.update(scroller, instance, measureRows)).toBe(true);
    expect(scroller.scrollTop).toBe(500);
    expect(virtualizer.scrollOffset).toBe(200);
    expect(virtualizer.scrollToOffset).toHaveBeenCalledWith(500, { behavior: "instant" });
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
      expect(anchor.update(scroller, instance, measureRows)).toBe(false);
      expect(scroller.scrollTop).toBe(200);
      expect(anchor.update(scroller, instance, measureRows)).toBe(false);
    },
  );
});
