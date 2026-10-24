/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { installTestLinkReader } from "../test-helpers/link-reader.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { linkReaderHovercardBootstrap } from "./link-reader-hovercard-registration.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";
import { Kbd } from "./solid/kbd.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";
import {
  createTooltip,
  createRichTooltip,
  createProvider,
  focusTrigger,
  dispatchMousePointer,
  dispatchTouchPointer,
  hoverTrigger,
  tooltipSurface as currentTooltipSurface,
  expectOpenCount,
  settleTooltip,
  type TooltipElement,
} from "./tooltip.test-support.ts";
import { focusWithoutTooltip } from "./tooltip.ts";

// Keep renderer-specific readiness and content lookup at the fixture boundary.
function commitTooltip(tooltip: TooltipElement) {
  return tooltip.updateComplete;
}

function commitTooltipSurface(tooltip: TooltipElement) {
  return settleTooltip(tooltip);
}

function tooltipIsRendered(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.querySelector(".tooltip-content") != null;
}

function tooltipIsOpen(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.matches(":popover-open");
}

function tooltipPlacement(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.getAttribute("placement");
}

function tooltipHasAnchor(tooltip: TooltipElement) {
  return Boolean(currentTooltipSurface(tooltip)?.style.getPropertyValue("position-anchor"));
}

function tooltipContent(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.querySelector(".tooltip-content");
}

function projectedTooltipContent(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)
    ?.querySelector<HTMLSlotElement>('slot[name="content"]')
    ?.assignedElements();
}

function interactiveTooltipContent(tooltip: TooltipElement) {
  return tooltip.shadowRoot?.querySelector(".tooltip-rich-content");
}

describe("openclaw-tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    "preserves focus options without opening a tooltip (wrapped=%s)",
    async (wrapped) => {
      const { tooltip, trigger } = createTooltip("Navigation action");
      document.body.append(wrapped ? tooltip : trigger);
      if (wrapped) {
        await commitTooltip(tooltip);
      }
      const focus = vi.spyOn(trigger, "focus");
      focusWithoutTooltip(trigger, { preventScroll: true });
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(trigger);
      await expectOpenCount(0);
    },
  );

  it.each([
    [undefined, "right-start"],
    [true, "bottom-start"],
  ] as const)(
    "positions side cards when narrow viewport support is %s",
    async (matches, placement) => {
      vi.stubGlobal("matchMedia", matches === undefined ? undefined : vi.fn(() => ({ matches })));
      try {
        const { tooltip, trigger } = createRichTooltip("Device details");
        tooltip.setAttribute("placement", "right-start");
        document.body.append(tooltip);
        await commitTooltip(tooltip);
        expect(tooltipIsRendered(tooltip)).toBe(false);
        focusTrigger(trigger);
        await expectOpenCount(1);
        expect(tooltipPlacement(tooltip)).toBe(placement);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    [undefined, "right"],
    ["bottom", "bottom"],
  ] as const)(
    "resolves placement %s inside a right-hint rail as %s",
    async (placement, expected) => {
      // Pin a wide viewport: narrow screens intentionally map side placements below.
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: false })),
      );
      try {
        const rail = document.createElement("nav");
        rail.dataset.tooltipPlacement = "right";
        const { tooltip, trigger } = createTooltip("New conversation");
        tooltip.placement = placement;
        rail.append(tooltip);
        document.body.append(rail);
        await commitTooltip(tooltip);
        focusTrigger(trigger);
        await expectOpenCount(1);
        expect(tooltipPlacement(tooltip)).toBe(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("renders slotted shortcuts without duplicating descriptions", async () => {
    const { tooltip, trigger, card } = createRichTooltip("");
    const view = mountSolid(
      () => ["Search (", createComponent(Kbd, { keys: ["⌘", "K"], inline: true }), ")"],
      { container: card },
    );
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
    expect(projectedTooltipContent(tooltip)).toEqual([card]);
    expect(card.querySelector("kbd svg")).not.toBeNull();
    expect(card.textContent?.replace(/\s+/gu, "")).toBe("Search(⌘K)");
    expect(tooltipContent(tooltip)?.textContent).toBe("");
    const descriptionId = trigger.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe("Search (⌘K)");

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);
    dispatchMousePointer(trigger, "pointerleave");
    vi.advanceTimersByTime(100);
    await expectOpenCount(0);
    focusTrigger(trigger);
    await expectOpenCount(1);
    dispatchMousePointer(trigger, "pointerdown");
    await expectOpenCount(0);

    view.unmount();
    card.remove();
    tooltip.content = "Search unavailable";
    await commitTooltip(tooltip);
    const content = tooltipContent(tooltip);
    expect(content?.querySelector("kbd")).toBeNull();
    expect(content?.textContent).toBe("Search unavailable");
    expect(document.getElementById(descriptionId)?.textContent).toBe("Search unavailable");
  });

  it("recognizes an HTML trigger created by another document realm", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument;
    if (!foreignDocument) {
      throw new Error("Expected iframe document");
    }
    const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
    tooltip.content = "Cross-realm tooltip";
    const trigger = foreignDocument.createElement("button");
    trigger.textContent = "trigger";
    tooltip.append(trigger);
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("restores the normal hover delay after the provider reconnects", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Delayed after reconnect");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
    provider.remove();
    await expectOpenCount(0);

    document.body.append(provider);
    await commitTooltip(tooltip);
    hoverTrigger(trigger);
    vi.advanceTimersByTime(149);
    await expectOpenCount(0);
    vi.advanceTimersByTime(1);
    await expectOpenCount(1);
  });

  it("retires listeners when an external anchor is replaced or the tooltip disconnects", async () => {
    const { tooltip, trigger } = createTooltip("Anchor details");
    const next = document.createElement("button");
    tooltip.anchor = trigger;
    document.body.append(trigger, next, tooltip);
    await commitTooltip(tooltip);
    focusTrigger(trigger);
    await expectOpenCount(1);

    tooltip.anchor = next;
    await settleTooltip(tooltip);
    await expectOpenCount(0);
    focusTrigger(trigger);
    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await expectOpenCount(0);
    focusTrigger(next);
    await expectOpenCount(1);

    tooltip.remove();
    focusTrigger(next);
    hoverTrigger(next);
    vi.advanceTimersByTime(150);
    document.body.append(tooltip);
    await settleTooltip(tooltip);
    await expectOpenCount(0);
    focusTrigger(next);
    await expectOpenCount(1);
  });

  it("suppresses repeated trigger text before opening and after content updates", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(0);
    hoverTrigger(trigger);
    vi.runAllTimers();
    await expectOpenCount(0);

    tooltip.content = "Additional model details";
    await commitTooltip(tooltip);
    focusTrigger(trigger);
    await expectOpenCount(1);

    tooltip.content = "Claude Opus 4.7";
    await commitTooltip(tooltip);
    await expectOpenCount(0);
  });

  it("keeps a repeated-label tooltip when the trigger clips its text", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    Object.defineProperty(trigger, "scrollWidth", { value: 160, configurable: true });
    Object.defineProperty(trigger, "clientWidth", { value: 80, configurable: true });
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
  });

  it.each(["width", "height", "marker", "hidden descendant", "faded descendant"] as const)(
    "keeps a repeated-label tooltip for nested overflow: %s",
    async (overflow) => {
      const provider = createProvider();
      const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "");
      const label = document.createElement("span");
      label.textContent = "Claude Opus 4.7 Anthropic";
      let target = label;
      if (overflow === "hidden descendant" || overflow === "faded descendant") {
        const wrapper = document.createElement("span");
        wrapper.hidden = overflow === "hidden descendant";
        wrapper.style.opacity = overflow === "faded descendant" ? "0" : "1";
        target = document.createElement("span");
        target.textContent = "Decorative text";
        wrapper.append(target);
        label.append(wrapper);
      }
      if (overflow === "width") {
        Object.defineProperty(target, "scrollWidth", { value: 160, configurable: true });
        Object.defineProperty(target, "clientWidth", { value: 80, configurable: true });
      } else if (overflow === "height") {
        Object.defineProperty(target, "scrollHeight", { value: 80, configurable: true });
        Object.defineProperty(target, "clientHeight", { value: 40, configurable: true });
      } else {
        target.setAttribute("data-tooltip-overflow", "");
      }
      trigger.append(label);
      provider.append(tooltip);
      document.body.append(provider);
      await commitTooltip(tooltip);

      focusTrigger(trigger);
      await expectOpenCount(1);
    },
  );

  it("does not reopen from pointer-origin focus after activation settles", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Pointer tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(pointerDown);
    trigger.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    trigger.click();
    focusTrigger(trigger);

    await expectOpenCount(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    focusTrigger(trigger);
    await expectOpenCount(1);
  });

  it("keeps touch hints explicit through open-on-click", async () => {
    const provider = createProvider();
    const action = createTooltip("Action tooltip");
    const reveal = createTooltip("Reveal tooltip");
    reveal.tooltip.openOnClick = true;
    provider.append(action.tooltip, reveal.tooltip);
    document.body.append(provider);
    await Promise.all([commitTooltip(action.tooltip), commitTooltip(reveal.tooltip)]);

    dispatchTouchPointer(action.trigger, "pointerdown");
    vi.advanceTimersByTime(450);
    await expectOpenCount(0);

    dispatchTouchPointer(reveal.trigger, "pointerdown");
    dispatchTouchPointer(reveal.trigger, "pointerup");
    reveal.trigger.click();
    await expectOpenCount(1);
  });

  it("pins reveal-only hints until toggled, dismissed, or replaced", async () => {
    const provider = createProvider();
    const reveal = createRichTooltip("Message context");
    const action = createTooltip("Reply");
    const outside = document.createElement("button");
    reveal.tooltip.openOnClick = true;
    provider.append(reveal.tooltip, action.tooltip, outside);
    document.body.append(provider);
    await Promise.all([commitTooltip(reveal.tooltip), commitTooltip(action.tooltip)]);

    hoverTrigger(reveal.trigger);
    vi.advanceTimersByTime(150);
    dispatchMousePointer(reveal.trigger, "pointerdown");
    reveal.trigger.click();
    dispatchMousePointer(reveal.trigger, "pointerleave");
    vi.advanceTimersByTime(500);
    await expectOpenCount(1);

    dispatchMousePointer(reveal.trigger, "pointerdown");
    reveal.trigger.click();
    await expectOpenCount(0);

    reveal.trigger.click();
    await commitTooltipSurface(reveal.tooltip);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    await expectOpenCount(0);
    expect(escape.defaultPrevented).toBe(true);
    await commitTooltipSurface(reveal.tooltip);

    reveal.trigger.click();
    dispatchMousePointer(outside, "pointerdown");
    await expectOpenCount(0);

    reveal.trigger.click();
    focusTrigger(action.trigger);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    focusTrigger(action.trigger);
    await settleTooltip(action.tooltip);
    expect(tooltipIsOpen(action.tooltip)).toBe(true);
    expect(tooltipIsOpen(reveal.tooltip)).toBe(false);
  });

  it("consumes only an unclaimed Escape while a tooltip is active", async () => {
    const { tooltip, trigger } = createTooltip("Keyboard hint");
    document.body.append(tooltip);
    await commitTooltip(tooltip);
    focusTrigger(trigger);
    const downstream = vi.fn();
    trigger.addEventListener("keydown", downstream);
    const descriptionId = trigger.getAttribute("aria-describedby");

    for (const key of ["Tab", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      if (key === "Escape") {
        event.preventDefault();
      }
      trigger.dispatchEvent(event);
      await expectOpenCount(1);
    }
    expect(downstream).toHaveBeenCalledTimes(2);

    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...composition,
      });
      trigger.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      await expectOpenCount(1);
      expect(downstream).toHaveBeenLastCalledWith(event);
    }
    expect(downstream).toHaveBeenCalledTimes(4);

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger.dispatchEvent(escape);
    await expectOpenCount(0);
    expect(escape.defaultPrevented).toBe(true);
    expect(downstream).toHaveBeenCalledTimes(4);
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe("Keyboard hint");

    const nextEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    trigger.dispatchEvent(nextEscape);
    expect(nextEscape.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(5);
  });

  it("honors per-tooltip hover intent while keyboard focus stays immediate", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createRichTooltip("Intentional hovercard");
    tooltip.delay = 600;
    tooltip.closeDelay = 300;
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(300);
    dispatchMousePointer(trigger, "pointerleave");
    await expectOpenCount(0);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(599);
    await expectOpenCount(0);
    vi.advanceTimersByTime(1);
    await expectOpenCount(1);

    dispatchMousePointer(trigger, "pointerleave");
    vi.advanceTimersByTime(299);
    await expectOpenCount(1);
    vi.advanceTimersByTime(1);
    await expectOpenCount(0);

    focusTrigger(trigger);
    await expectOpenCount(1);

    trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    await settleTooltip(tooltip);
    hoverTrigger(trigger);
    vi.advanceTimersByTime(0);
    await expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
  });

  it("refreshes the rich description when assigned descendants change", async () => {
    const { tooltip, trigger, card } = createRichTooltip("");
    const detail = document.createElement("span");
    detail.textContent = "Initial detail";
    card.append(detail);
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    const descriptionId = trigger.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe("Initial detail");

    tooltip.remove();
    document.body.append(tooltip);
    await commitTooltip(tooltip);
    detail.textContent = "Updated detail";
    await Promise.resolve();
    expect(document.getElementById(descriptionId)?.textContent).toBe("Updated detail");
  });

  it.each([true])(
    "returns Escape focus from rich content to its trigger (wrapped=%s)",
    async (wrapped) => {
      const { tooltip, trigger: directTrigger, card } = createRichTooltip("Focusable card");
      const trigger = wrapped ? document.createElement("button") : directTrigger;
      if (wrapped) {
        const wrapper = document.createElement("span");
        trigger.textContent = directTrigger.textContent;
        wrapper.append(trigger);
        directTrigger.replaceWith(wrapper);
      }
      tooltip.descriptionTarget = () => trigger;
      const action = document.createElement("button");
      action.textContent = "Card action";
      card.append(action);
      document.body.append(tooltip);
      await settleTooltip(tooltip);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      await expectOpenCount(1);
      action.focus();
      await expectOpenCount(1);
      action.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(trigger);
      await expectOpenCount(0);
      vi.advanceTimersByTime(500);
      await expectOpenCount(0);
    },
  );

  it("stays open when a focused trigger is swept through and out of rich content", async () => {
    const { tooltip, trigger } = createRichTooltip("Scrollable card");
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    hoverTrigger(trigger);
    await settleTooltip(tooltip);
    const richContent = interactiveTooltipContent(tooltip);
    dispatchMousePointer(trigger, "pointerleave");
    if (richContent) {
      dispatchMousePointer(richContent, "pointerenter");
      dispatchMousePointer(richContent, "pointerleave");
    }
    vi.advanceTimersByTime(100);

    expect(document.activeElement).toBe(trigger);
    await expectOpenCount(1);
  });

  it("releases the active provider reference when an open tooltip is removed", async () => {
    const provider = createProvider();
    const first = createTooltip("First tooltip");
    provider.append(first.tooltip);
    document.body.append(provider);
    await commitTooltip(first.tooltip);

    focusTrigger(first.trigger);
    await expectOpenCount(1);
    first.tooltip.remove();
    await expectOpenCount(0);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const downstream = vi.fn();
    provider.addEventListener("keydown", downstream);
    provider.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300);

    const second = createTooltip("Second tooltip");
    provider.append(second.tooltip);
    await commitTooltip(second.tooltip);
    hoverTrigger(second.trigger);
    vi.advanceTimersByTime(149);
    await expectOpenCount(0);
    vi.advanceTimersByTime(1);
    await expectOpenCount(1);
  });
});

describe("title tooltips", () => {
  let stopGuard: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stopGuard = installTitleTooltips(document);
  });

  afterEach(() => {
    stopGuard?.();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("suppresses a redundant title through open shadow DOM until true pointer leave", () => {
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    trigger.title = "GPT-5.6 Sol";
    const label = document.createElement("span");
    label.textContent = "GPT-5.6 Sol";
    trigger.append(label);
    shadowRoot.append(trigger);
    document.body.append(host);

    label.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(trigger.getAttribute("title")).toBe("");
    label.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(trigger.getAttribute("title")).toBe("");

    trigger.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(trigger.title).toBe("GPT-5.6 Sol");
  });

  it.each([
    {
      name: "hidden-only label",
      title: "Open settings",
      text: "Open settings",
      prepare: (trigger: HTMLElement) => {
        trigger.firstElementChild?.setAttribute("hidden", "");
      },
    },
  ])("routes $name titles through the shared tooltip", async ({ title, text, prepare }) => {
    const trigger = document.createElement("button");
    trigger.title = title;
    const label = document.createElement("span");
    label.textContent = text;
    trigger.append(label);
    prepare(trigger);
    document.body.append(trigger);

    label.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(trigger.title).toBe("");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip");
    expect(tooltip).not.toBeNull();
    await commitTooltip(tooltip!);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip!);
    expect(tooltipIsOpen(tooltip!)).toBe(true);
    expect(tooltip!.content).toBe(title);
  });

  it("opens adapted titles on their rail's declared side", async () => {
    // Pin a wide viewport: narrow screens intentionally map side placements below.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    try {
      const rail = document.createElement("nav");
      rail.dataset.tooltipPlacement = "right";
      const trigger = document.createElement("button");
      trigger.title = "Pages";
      rail.append(trigger);
      document.body.append(rail);

      dispatchMousePointer(trigger, "pointerover");

      const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip");
      expect(tooltip).not.toBeNull();
      await commitTooltip(tooltip!);
      vi.advanceTimersByTime(150);
      await settleTooltip(tooltip!);
      expect(tooltipIsOpen(tooltip!)).toBe(true);
      expect(tooltipPlacement(tooltip!)).toBe("right");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares delay and exclusivity with explicit tooltips without moving titled nodes", async () => {
    const provider = createProvider();
    const explicit = createTooltip("Reply");
    const trigger = document.createElement("button");
    trigger.title = "Full timestamp";
    trigger.setAttribute("aria-label", "Message timestamp");
    provider.append(explicit.tooltip, trigger);
    document.body.append(provider);
    await commitTooltip(explicit.tooltip);

    dispatchMousePointer(trigger, "pointerover");
    const delegated = [...document.querySelectorAll<TooltipElement>("openclaw-tooltip")].find(
      (tooltip) => tooltip !== explicit.tooltip,
    );
    expect(delegated).toBeDefined();
    await commitTooltip(delegated!);
    vi.advanceTimersByTime(149);
    await expectOpenCount(0);
    vi.advanceTimersByTime(1);
    await expectOpenCount(1);
    expect(trigger.parentElement).toBe(provider);
    expect(trigger.getAttribute("aria-label")).toBe("Message timestamp");

    hoverTrigger(explicit.trigger);
    vi.advanceTimersByTime(0);
    await settleTooltip(explicit.tooltip);
    expect(tooltipIsOpen(delegated!)).toBe(false);
    expect(tooltipIsOpen(explicit.tooltip)).toBe(true);
  });

  it("yields a focused title tooltip to a rich card without restoring the native title", async () => {
    const trigger = document.createElement("a");
    trigger.href = "https://example.com/item";
    trigger.title = trigger.href;
    trigger.textContent = "Item";
    document.body.append(trigger);
    const activate = () => focusTrigger(trigger);
    activate();
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);

    const hovercard = createPortaledHovercardOwner(() => hovercard.reset());
    hovercard.markTrigger(trigger);
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(1);

    hovercard.mount(trigger, createPortaledHovercard("item-preview", "preview"), "vertical");
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    expect(trigger.title).toBe("");
    activate();
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    await expectOpenCount(0);

    hovercard.reset();
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
    trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(trigger.title).toBe(trigger.href);
    activate();
    await settleTooltip(document.querySelector<TooltipElement>("openclaw-tooltip")!);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);
  });

  it.each(["link"])(
    "claims preview ownership when an active %s moves into a provider",
    async (moved) => {
      const provider = installTestLinkReader(
        document.createElement("openclaw-link-reader-hovercard-provider"),
      );
      const wrapper = document.createElement("div");
      const link = document.createElement("a");
      link.href = "https://github.com/openclaw/openclaw/pull/99816";
      link.title = "Pull request details";
      link.textContent = "#99816";
      wrapper.append(link);
      document.body.append(provider, wrapper);
      dispatchMousePointer(link, "pointerover");
      // previewForAnchor arms its hover timer after the tooltip's first commit.
      const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
      await commitTooltip(tooltip);
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(1);
      provider.append(moved === "link" ? link : wrapper);
      await vi.advanceTimersByTimeAsync(0);
      await settleTooltip(tooltip);
      expect(tooltip.hasAttribute("open")).toBe(false);
      expect(tooltip.content).toBe("");
      // Accepted closure precedes the native top layer's finite exit work.
      finishElementAnimations(currentTooltipSurface(tooltip)!);
      vi.advanceTimersToNextFrame();
      await expectOpenCount(0);
      expect(link.title).toBe("");
      expect(link.hasAttribute("aria-expanded")).toBe(false);
      document.body.append(moved === "link" ? link : wrapper);
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(0);
      dispatchMousePointer(link, "pointerleave");
      expect(link.title).toBe("Pull request details");
      dispatchMousePointer(link, "pointerover");
      await commitTooltip(document.querySelector<TooltipElement>("openclaw-tooltip")!);
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(1);
      expect(link.href).toBe("https://github.com/openclaw/openclaw/pull/99816");
    },
  );

  it("keeps inherited titles scoped when moving between a GitHub link and an ordinary control", async () => {
    const parent = document.createElement("div");
    parent.title = "Shared context hint";
    const provider = installTestLinkReader(
      document.createElement("openclaw-link-reader-hovercard-provider"),
    );
    const link = document.createElement("a");
    link.href = "https://github.com/openclaw/openclaw/pull/99816";
    link.textContent = "#99816";
    const control = document.createElement("button");
    control.textContent = "Ordinary control";
    provider.append(link);
    parent.append(provider, control);
    document.body.append(parent);
    try {
      dispatchMousePointer(link, "pointerover");
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(0);
      expect(parent.title).toBe("");
      expect(link.hasAttribute("aria-expanded")).toBe(false);
      dispatchMousePointer(control, "pointerover");
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(1);
      expect(document.querySelector<TooltipElement>("openclaw-tooltip")?.content).toBe(
        "Shared context hint",
      );
      dispatchMousePointer(parent, "pointerleave");
      expect(parent.title).toBe("Shared context hint");
    } finally {
      parent.remove();
      await linkReaderHovercardBootstrap.define();
    }
  });

  it("yields a nested title when its link becomes preview eligible and restores ordinary hints on reentry", async () => {
    const provider = installTestLinkReader(
      document.createElement("openclaw-link-reader-hovercard-provider"),
    );
    const link = document.createElement("a");
    link.href = "https://example.com/item";
    const label = document.createElement("span");
    label.textContent = "Details";
    label.title = "Detailed hint";
    link.append(label);
    provider.append(link);
    document.body.append(provider);
    dispatchMousePointer(label, "pointerover");
    await vi.advanceTimersByTimeAsync(200);
    await expectOpenCount(1);
    link.href = "https://github.com/openclaw/openclaw/pull/99816?plain=1#issuecomment-7";
    await vi.advanceTimersByTimeAsync(200);
    await expectOpenCount(0);
    expect(label.title).toBe("");
    expect(link.hasAttribute("aria-expanded")).toBe(false);
    expect(link.href).toBe(
      "https://github.com/openclaw/openclaw/pull/99816?plain=1#issuecomment-7",
    );
    link.href = "https://example.com/item";
    dispatchMousePointer(label, "pointerleave");
    expect(label.title).toBe("Detailed hint");
    dispatchMousePointer(label, "pointerover");
    await vi.advanceTimersByTimeAsync(200);
    await expectOpenCount(1);
  });

  it("preserves a new rich content range after replacing a dismissed title hint", async () => {
    const ordinary = document.createElement("button");
    ordinary.title = "Ordinary hint";
    const file = document.createElement("a");
    file.href = "/workspace/example.ts";
    file.dataset.filePath = "/workspace/example.ts";
    file.textContent = "Source";
    document.body.append(ordinary, file);
    focusTrigger(ordinary);
    await settleTooltip(document.querySelector<TooltipElement>("openclaw-tooltip")!);
    dispatchMousePointer(ordinary, "pointerleave");
    ordinary.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    focusTrigger(file);
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await settleTooltip(tooltip);
    const content = tooltip.querySelector('[slot="content"]');
    expect(content).not.toBeNull();
    expect(projectedTooltipContent(tooltip)).toEqual([content]);
    expect(content?.textContent).toContain("/workspace/example.ts");
  });

  it("dismisses an active title when it is removed", async () => {
    const trigger = document.createElement("button");
    trigger.title = "Action unavailable";
    document.body.append(trigger);
    dispatchMousePointer(trigger, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);

    trigger.removeAttribute("title");
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.getAttribute("title")).toBeNull();
    trigger.title = "Action available";
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
    expect(trigger.getAttribute("title")).toBe("Action available");
    dispatchMousePointer(trigger, "pointerover");
    await settleTooltip(document.querySelector<TooltipElement>("openclaw-tooltip")!);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);
  });

  it("keeps an inherited hint on its focused control until focus moves to a sibling", async () => {
    const wrapper = document.createElement("div");
    wrapper.title = "Shared action details";
    const first = document.createElement("button");
    const second = document.createElement("button");
    first.textContent = "First action";
    second.textContent = "Second action";
    first.setAttribute("aria-describedby", "first-description");
    second.setAttribute("aria-describedby", "second-description");
    wrapper.append(first, second);
    document.body.append(wrapper);

    second.focus();
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await settleTooltip(tooltip);
    const ids = (second.getAttribute("aria-describedby") ?? "").split(/\s+/u);
    expect(ids).toHaveLength(2);
    const descriptionId = ids.find((id) => id !== "second-description")!;
    expect(document.getElementById(descriptionId)?.textContent).toBe("Shared action details");
    expect(first.getAttribute("aria-describedby")).toBe("first-description");
    expect(wrapper.hasAttribute("aria-describedby")).toBe(false);
    const surface = currentTooltipSurface(tooltip);
    expect(tooltipIsOpen(tooltip)).toBe(true);

    for (const target of [first, wrapper]) {
      dispatchMousePointer(target, "pointerover");
      await settleTooltip(tooltip);
      expect(second.getAttribute("aria-describedby")).toBe(`second-description ${descriptionId}`);
      expect(first.getAttribute("aria-describedby")).toBe("first-description");
    }

    first.focus();
    await settleTooltip(tooltip);
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-describedby")).toBe(`first-description ${descriptionId}`);
    expect(second.getAttribute("aria-describedby")).toBe("second-description");
    expect(document.querySelector("openclaw-tooltip")).toBe(tooltip);
    expect(currentTooltipSurface(tooltip)).toBe(surface);
    expect(tooltipIsOpen(tooltip)).toBe(true);
  });

  it("describes a titled label's associated control and follows its next pointer discovery", async () => {
    const label = document.createElement("label");
    label.title = "Account details";
    label.textContent = "Account";
    const first = document.createElement("input");
    const second = document.createElement("input");
    first.id = "first-account";
    second.id = "second-account";
    first.setAttribute("aria-describedby", "first-description");
    second.setAttribute("aria-describedby", "second-description");
    label.htmlFor = first.id;
    document.body.append(label, first, second);

    dispatchMousePointer(label, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await settleTooltip(tooltip);
    const ids = (first.getAttribute("aria-describedby") ?? "").split(/\s+/u);
    expect(ids).toHaveLength(2);
    const descriptionId = ids.find((id) => id !== "first-description")!;
    expect(document.getElementById(descriptionId)?.textContent).toBe("Account details");
    expect(label.hasAttribute("aria-describedby")).toBe(false);
    expect(second.getAttribute("aria-describedby")).toBe("second-description");

    label.htmlFor = second.id;
    dispatchMousePointer(label, "pointerover");
    await settleTooltip(tooltip);
    expect(first.getAttribute("aria-describedby")).toBe("first-description");
    expect(second.getAttribute("aria-describedby")).toBe(`second-description ${descriptionId}`);
    expect(label.hasAttribute("aria-describedby")).toBe(false);
    expect(document.querySelector("openclaw-tooltip")).toBe(tooltip);
  });

  it("uses the nearest inherited title through shadow DOM and preserves iframe names", async () => {
    const parent = document.createElement("div");
    parent.title = "Inherited hint";
    const shadow = parent.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    shadow.append(trigger);
    document.body.append(parent);
    focusTrigger(trigger);
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await commitTooltip(tooltip);
    expect(tooltip.content).toBe("Inherited hint");
    await settleTooltip(tooltip);
    const descriptionId = trigger.getAttribute("aria-describedby") ?? "";
    expect(shadow.getElementById(descriptionId)?.textContent).toBe("Inherited hint");
    expect(parent.hasAttribute("aria-describedby")).toBe(false);
    expect(tooltipIsOpen(tooltip)).toBe(true);

    const iframe = document.createElement("iframe");
    iframe.title = "Dashboard document";
    document.body.append(iframe);
    dispatchMousePointer(iframe, "pointerover");
    expect(iframe.title).toBe("Dashboard document");
  });

  it("adapts SVG data hints through the same popup without changing their accessible name", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("data-tooltip", "12 requests");
    rect.setAttribute("aria-label", "12 requests");
    svg.append(rect);
    document.body.append(svg);
    dispatchMousePointer(rect, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await commitTooltip(tooltip);
    await commitTooltipSurface(tooltip);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
    expect(tooltipIsOpen(tooltip)).toBe(true);
    expect(tooltipHasAnchor(tooltip)).toBe(true);
    expect(rect.getAttribute("aria-label")).toBe("12 requests");
  });
});
