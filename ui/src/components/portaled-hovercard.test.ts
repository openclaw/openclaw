/* @vitest-environment jsdom */
import { delegateEvents } from "@solidjs/web";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { controlsForHovercard } from "./portaled-hovercard-focus.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";

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
  const controller = createPortaledHovercardOwner(dismiss);
  controller.markTrigger(trigger);
  onTestFinished(() => controller.reset());
  const mount = () => {
    const card = createPortaledHovercard("preview", "preview");
    controller.mount(trigger, card, "vertical");
    controller.pointerOverCard = true;
    return card;
  };
  return { pane, trigger, controller, dismiss, mount };
}

function keydown(target: EventTarget, key: string, cancelable = true) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable });
  target.dispatchEvent(event);
  return event;
}

it.each(["Tab", "Escape"])("enters registered controls and returns focus on %s", (key) => {
  const { controller, trigger } = fixture();
  trigger.href = "#trigger";
  const card = createPortaledHovercard("keyboard-preview", "preview");
  const unrelated = document.createElement("button");
  const first = document.createElement("button");
  const last = document.createElement("button");
  card.append(unrelated, first, last);
  const controls = controlsForHovercard(card);
  const releaseFirst = controls.registerSource(() => [first]);
  const releaseLast = controls.registerSource(() => [last]);
  controller.mount(trigger, card, "vertical", true, () => {
    releaseFirst();
    releaseLast();
  });
  trigger.addEventListener("keydown", controller.handleTriggerKeyDown);
  trigger.focus();
  const enter = keydown(trigger, "Tab");
  expect(enter.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);

  const interior = keydown(first, "Tab");
  expect(interior.defaultPrevented).toBe(false);
  last.focus();
  const exit = keydown(last, key);
  expect(exit.defaultPrevented).toBe(true);
  expect(controller.card).toBeNull();
  expect(document.activeElement).toBe(trigger);
  document.body.append(card);
  expect(controls.read()).toEqual([]);
});

it("keeps a Solid card open while its links hold focus and closes after focus leaves", async () => {
  vi.useFakeTimers();
  const { controller, trigger, dismiss } = fixture();
  const card = createPortaledHovercard("solid-preview", "preview");
  const content = document.createElement("div");
  const first = Object.assign(document.createElement("a"), { href: "#first" });
  const second = Object.assign(document.createElement("a"), { href: "#second" });
  content.append(first, second);
  const controls = controlsForHovercard(card);
  onTestFinished(controls.registerSource(() => [first]));
  onTestFinished(controls.registerSource(() => [second]));
  // The application delegates these events before the portal installs native listeners.
  delegateEvents(["focusin", "focusout"]);
  mountSolid(() => content, { container: card });
  const showPopover = card.showPopover.bind(card);
  vi.spyOn(card, "showPopover").mockImplementation(() => {
    showPopover();
    first.focus();
  });
  controller.mount(trigger, card, "vertical");

  expect(document.activeElement).toBe(first);
  controller.handleCardPointerLeave();
  for (const focused of [first, second]) {
    focused.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(card.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(dismiss).not.toHaveBeenCalled();
  }

  trigger.href = "#outside";
  trigger.focus();
  await vi.advanceTimersByTimeAsync(200);
  expect(controller.card).toBeNull();
  expect(dismiss).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "retires animated exits without waiting for reduced motion (%s)",
  async (reduced) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduced })),
    );
    const { controller, mount } = fixture();
    const card = mount();
    controller.reset(100);
    expect(card.isConnected).toBe(!reduced);
    if (!reduced) {
      await vi.advanceTimersByTimeAsync(150);
      expect(card.isConnected).toBe(false);
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retires card listeners before an animated card is replaced", () => {
  vi.useFakeTimers();
  const { controller, mount, trigger, dismiss } = fixture();
  mount();
  const previous = controller.card!;
  controller.reset(100);
  controller.markTrigger(trigger);
  mount();

  keydown(previous, "Escape", false);
  expect(dismiss).not.toHaveBeenCalled();
  expect(controller.card?.isConnected).toBe(true);
  expect(previous.isConnected).toBe(false);

  keydown(controller.card!, "Escape", false);
  expect(dismiss).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "ignores unrelated scrolls and coalesces anchor movement (shadow=%s)",
  (shadow) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const { controller, trigger, mount, pane } = fixture(shadow);
    const other = document.body.appendChild(document.createElement("section"));
    let top = 100;
    const measure = vi
      .spyOn(trigger, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(20, top, 100, 20));
    mount();
    expect(controller.card?.style.top).toBe("130px");
    measure.mockClear();
    for (let index = 0; index < 100; index++) {
      other.dispatchEvent(new Event("scroll"));
    }
    vi.advanceTimersToNextFrame();
    expect(measure).not.toHaveBeenCalled();

    top = 140;
    for (let index = 0; index < 5; index++) {
      pane.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    }
    expect(measure).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(controller.card?.style.top).toBe("170px");

    measure.mockClear();
    pane.dispatchEvent(new Event("scroll"));
    controller.reset();
    vi.advanceTimersToNextFrame();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
    expect(measure).not.toHaveBeenCalled();
  },
);

it.each(["pending", "held"])("retires a %s card across shadow ancestry", async (phase) => {
  vi.useFakeTimers();
  const { controller, trigger, dismiss, mount, pane } = fixture(true);
  const open = vi.fn(mount);
  if (phase === "pending") {
    controller.scheduleOpen(100, open);
  } else {
    mount();
  }
  pane.setAttribute("aria-hidden", "true");
  await vi.advanceTimersByTimeAsync(100);
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector(".preview")).toBeNull();
  expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
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
