/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function fixture(shadow = false) {
  const pane = document.body.appendChild(document.createElement("section"));
  const owner = shadow ? pane.attachShadow({ mode: "open" }) : pane;
  const trigger = owner.appendChild(document.createElement("a"));
  const dismiss = vi.fn(() => controller.reset());
  const controller = new PortaledHovercardController(dismiss);
  controller.markTrigger(trigger);
  const mount = () => {
    controller.mount(trigger, createPortaledHovercard("preview", "preview"), "vertical");
    controller.pointerOverCard = true;
  };
  return { pane, trigger, controller, dismiss, mount };
}

describe("portaled hovercard presentation ownership", () => {
  it.each(["pending", "held"])("retires a %s card across shadow ancestry", async (phase) => {
    vi.useFakeTimers();
    const view = fixture(true);
    const open = vi.fn(view.mount);
    if (phase === "pending") {
      view.controller.scheduleOpen(100, open);
    } else {
      view.mount();
    }
    view.pane.setAttribute("aria-hidden", "true");
    await vi.advanceTimersByTimeAsync(100);
    expect(view.dismiss).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector(".preview")).toBeNull();
    expect(view.trigger.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("tracks a moved trigger and releases observation on reset or replacement", async () => {
    const first = fixture();
    first.mount();
    const nextPane = document.body.appendChild(document.createElement("section"));
    nextPane.append(first.trigger);
    await Promise.resolve();
    first.pane.setAttribute("inert", "");
    await Promise.resolve();
    expect(first.controller.card?.isConnected).toBe(true);
    nextPane.setAttribute("inert", "");
    await Promise.resolve();
    expect(first.controller.card).toBeNull();
    const nextTrigger = document.body.appendChild(document.createElement("a"));
    first.controller.markTrigger(nextTrigger);
    first.controller.mount(nextTrigger, createPortaledHovercard("next", "preview"), "vertical");
    first.pane.remove();
    await Promise.resolve();
    expect(first.controller.card?.isConnected).toBe(true);
    first.controller.reset();
    nextTrigger.remove();
    await Promise.resolve();
    expect(first.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps a modal's card with its trigger and retires it when the modal disconnects", async () => {
    const modal = document.body.appendChild(document.createElement("openclaw-modal-dialog"));
    const trigger = modal.appendChild(document.createElement("a"));
    const controller = new PortaledHovercardController(() => controller.reset());
    controller.markTrigger(trigger);
    controller.mount(trigger, createPortaledHovercard("modal-preview", "preview"), "vertical");
    await Promise.resolve();
    expect(controller.card?.parentElement).toBe(modal);
    modal.remove();
    await Promise.resolve();
    expect(controller.card).toBeNull();
  });
});

describe("horizontal placement fallback", () => {
  function horizontalFixture(innerW: number, anchorRect: DOMRect, cardW: number, cardH: number) {
    Object.defineProperty(window, "innerWidth", {
      value: innerW,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 1000,
      writable: true,
      configurable: true,
    });
    const anchor = document.body.appendChild(document.createElement("a"));
    anchor.getBoundingClientRect = () => anchorRect;
    const controller = new PortaledHovercardController(() => controller.reset());
    controller.markTrigger(anchor);
    controller.mount(anchor, createPortaledHovercard("card", "preview"), "horizontal");
    controller.pointerOverCard = true;
    const card = controller.card!;
    Object.defineProperty(card, "offsetWidth", { value: cardW, configurable: true });
    Object.defineProperty(card, "offsetHeight", { value: cardH, configurable: true });
    controller.position();
    return { anchor, card, controller };
  }

  it("places card on the right when it fits", () => {
    const { card } = horizontalFixture(
      1000,
      {
        x: 10,
        y: 100,
        width: 200,
        height: 30,
        right: 210,
        left: 10,
        top: 100,
        bottom: 130,
        toJSON: () => ({}),
      } as DOMRect,
      300,
      100,
    );
    expect(card.dataset.side).toBe("right");
  });

  it("places card on the left when right does not fit but left does", () => {
    const { card } = horizontalFixture(
      400,
      {
        x: 310,
        y: 100,
        width: 80,
        height: 30,
        right: 390,
        left: 310,
        top: 100,
        bottom: 130,
        toJSON: () => ({}),
      } as DOMRect,
      250,
      100,
    );
    expect(card.dataset.side).toBe("left");
  });

  it("falls through to vertical placement when neither side fits", () => {
    const { card } = horizontalFixture(
      390,
      {
        x: 14,
        y: 384,
        width: 282,
        height: 30,
        right: 296,
        left: 14,
        top: 384,
        bottom: 414,
        toJSON: () => ({}),
      } as DOMRect,
      294,
      136,
    );
    expect(card.dataset.side).not.toBe("left");
    expect(card.dataset.side).not.toBe("right");
    expect(["bottom", "top"]).toContain(card.dataset.side);
  });

  it("vertical fallback places card below when below fits", () => {
    const { card } = horizontalFixture(
      390,
      {
        x: 14,
        y: 384,
        width: 282,
        height: 30,
        right: 296,
        left: 14,
        top: 384,
        bottom: 414,
        toJSON: () => ({}),
      } as DOMRect,
      294,
      136,
    );
    expect(card.dataset.side).toBe("bottom");
  });

  it("vertical fallback places card above when below does not fit", () => {
    const { card } = horizontalFixture(
      390,
      {
        x: 14,
        y: 900,
        width: 282,
        height: 30,
        right: 296,
        left: 14,
        top: 900,
        bottom: 930,
        toJSON: () => ({}),
      } as DOMRect,
      294,
      136,
    );
    expect(card.dataset.side).toBe("top");
  });

  it("retains horizontal clamping when neither vertical side fits either", () => {
    const { card, controller } = horizontalFixture(
      390,
      {
        x: 14,
        y: 384,
        width: 282,
        height: 30,
        right: 296,
        left: 14,
        top: 384,
        bottom: 414,
        toJSON: () => ({}),
      } as DOMRect,
      294,
      520,
    );
    // 520px card in 844px viewport: below needs 414+10+520+12=956 > 844, above needs 384-10-520-12 < 0
    Object.defineProperty(window, "innerHeight", {
      value: 844,
      writable: true,
      configurable: true,
    });
    controller.position();
    expect(card.dataset.side).toBe("left");
    expect(Number.parseInt(card.style.top, 10)).toBe(312);
  });
});
