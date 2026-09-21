/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  it.each([false, true])(
    "retires animated exits without waiting for reduced motion (%s)",
    async (reduced) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: reduced })),
      );
      const view = fixture();
      view.mount();
      const card = view.controller.card;
      if (!card) {
        throw new Error("Expected the mounted hovercard");
      }
      try {
        view.controller.reset(100);
        expect(card.isConnected).toBe(!reduced);
        if (!reduced) {
          await vi.advanceTimersByTimeAsync(150);
          expect(card.isConnected).toBe(false);
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        view.controller.reset();
      }
    },
  );

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

  it.each([false, true])(
    "keeps a modal's card with its trigger and retires it when the modal disconnects (shadow=%s)",
    async (shadow) => {
      const modal = document.body.appendChild(document.createElement("openclaw-modal-dialog"));
      const content = modal.appendChild(document.createElement("section"));
      const root = shadow ? content.attachShadow({ mode: "open" }) : content;
      const trigger = root.appendChild(document.createElement("a"));
      const controller = new PortaledHovercardController(() => controller.reset());
      controller.markTrigger(trigger);
      controller.mount(trigger, createPortaledHovercard("modal-preview", "preview"), "vertical");
      await Promise.resolve();
      expect(controller.card?.parentElement).toBe(modal);
      modal.remove();
      await Promise.resolve();
      expect(controller.card).toBeNull();
    },
  );
});
