/* @vitest-environment jsdom */
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestLinkReader } from "../test-helpers/link-reader.ts";
import { renderKbd } from "./kbd.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import { installTitleTooltips } from "./tooltip-title.ts";
import {
  createTooltip,
  createRichTooltip,
  createProvider,
  focusTrigger,
  dispatchMousePointer,
  dispatchTouchPointer,
  hoverTrigger,
  webAwesomeTooltip as currentTooltipSurface,
  expectOpenCount,
  settleTooltip,
  type TooltipElement,
} from "./tooltip.test-support.ts";

// Keep renderer-specific readiness and content lookup at the fixture boundary.
function commitTooltip(tooltip: TooltipElement) {
  return tooltip.updateComplete;
}

function commitTooltipSurface(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.updateComplete;
}

function tooltipIsRendered(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip) !== null;
}

function tooltipIsOpen(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.open;
}

function tooltipPlacement(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.getAttribute("placement");
}

function tooltipAnchor(tooltip: TooltipElement) {
  return currentTooltipSurface(tooltip)?.anchor;
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

function expectSharedTooltipSkin(tooltip: TooltipElement) {
  const styles = [...(tooltip.shadowRoot?.querySelectorAll("style") ?? [])]
    .map((style) => style.textContent)
    .join("\n");
  expect(styles).toContain("--wa-tooltip-background-color:");
  expect(styles).toContain("--wa-tooltip-border-color:");
  expect(styles).toContain("--wa-tooltip-border-width: 1px");
  expect(styles).toContain("--wa-tooltip-border-style: solid");
  expect(styles).toContain("--wa-tooltip-arrow-size: var(--openclaw-tooltip-arrow-size, 0px)");
  expect(styles).toContain("var(--overlay-border, var(--border-strong))");
  expect(styles).toContain("var(--overlay-shadow, var(--shadow-md))");
  expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  expect(styles).toContain("animation: none");
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

  it.each([
    [undefined, "right-start"],
    [false, "right-start"],
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

  it("reattaches trigger listeners after reconnect", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Reconnect tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);

    provider.remove();
    await expectOpenCount(0);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
  });

  it("keeps show reentry idempotent", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Single portal");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    focusTrigger(trigger);

    await expectOpenCount(1);
    expect(tooltipContent(tooltip)?.textContent).toBe("Single portal");
  });

  it("renders shortcut templates without changing plain descriptions or dismissal", async () => {
    const { tooltip, trigger } = createTooltip("Search (⌘K)");
    tooltip.contentTemplate = html`Search (${renderKbd(["⌘", "K"], { inline: true })})`;
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
    const content = tooltipContent(tooltip);
    expect(content?.querySelector("kbd svg")).not.toBeNull();
    expect(content?.textContent?.replace(/\s+/gu, "")).toBe("Search(⌘K)");
    const descriptionId = trigger.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe("Search (⌘K)");

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);
    dispatchMousePointer(trigger, "pointerleave");
    await expectOpenCount(0);
    focusTrigger(trigger);
    await expectOpenCount(1);
    dispatchMousePointer(trigger, "pointerdown");
    await expectOpenCount(0);

    tooltip.contentTemplate = undefined;
    tooltip.content = "Search unavailable";
    await commitTooltip(tooltip);
    expect(content?.querySelector("kbd")).toBeNull();
    expect(content?.textContent).toBe("Search unavailable");
    expect(document.getElementById(descriptionId)?.textContent).toBe("Search unavailable");
  });

  it("skins the body and removes the arrow through shared overlay tokens", async () => {
    const { tooltip } = createTooltip("Styled tooltip");
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    expectSharedTooltipSkin(tooltip);
  });

  it("projects rich content into the tooltip", async () => {
    const { tooltip, trigger, card } = createRichTooltip("Rich card", "Rich card");
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await settleTooltip(tooltip);
    expect(projectedTooltipContent(tooltip)).toEqual([card]);

    await expectOpenCount(1);
  });

  it("anchors the tooltip after its initial render", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Anchored tooltip");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);
    focusTrigger(trigger);
    await settleTooltip(tooltip);

    expect(tooltipAnchor(tooltip)).toBe(trigger);
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

  it("keeps a repeated-label tooltip with an explicit overflow marker", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "Claude Opus 4.7 Anthropic");
    trigger.setAttribute("data-tooltip-overflow", "");
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
  });

  it("keeps a repeated-label tooltip when a nested label clips", async () => {
    const provider = createProvider();
    const { tooltip, trigger } = createTooltip("Claude Opus 4.7", "");
    const label = document.createElement("span");
    label.textContent = "Claude Opus 4.7 Anthropic";
    Object.defineProperty(label, "scrollWidth", { value: 160, configurable: true });
    Object.defineProperty(label, "clientWidth", { value: 80, configurable: true });
    trigger.append(label);
    provider.append(tooltip);
    document.body.append(provider);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    await expectOpenCount(1);
  });

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

  it("keeps portaled and provider-scoped tooltips mutually exclusive", async () => {
    const provider = createProvider();
    const scoped = createTooltip("Reply");
    const portaled = createTooltip("Menu action");
    provider.append(scoped.tooltip);
    document.body.append(provider, portaled.tooltip);
    await Promise.all([commitTooltip(scoped.tooltip), commitTooltip(portaled.tooltip)]);

    hoverTrigger(scoped.trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(scoped.tooltip);
    expect(tooltipIsOpen(scoped.tooltip)).toBe(true);
    hoverTrigger(portaled.trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(portaled.tooltip);
    expect(tooltipIsOpen(portaled.tooltip)).toBe(true);
    expect(tooltipIsOpen(scoped.tooltip)).toBe(false);
    hoverTrigger(scoped.trigger);
    vi.advanceTimersByTime(150);
    expect(tooltipIsOpen(portaled.tooltip)).toBe(false);
    await settleTooltip(scoped.tooltip);
    expect(tooltipIsOpen(scoped.tooltip)).toBe(true);
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
    hoverTrigger(trigger);
    vi.advanceTimersByTime(0);
    await expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
  });

  it("describes the focusable element inside a wrapper trigger", async () => {
    const tooltip = document.createElement("openclaw-tooltip") as TooltipElement;
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.href = "#session";
    link.textContent = "Release notes";
    row.append(link);
    const card = document.createElement("div");
    card.slot = "content";
    card.textContent = "Branch feature/sidebar";
    tooltip.append(row, card);
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    expect(row.hasAttribute("aria-describedby")).toBe(false);
    const descriptionId = link.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Branch feature/sidebar",
    );
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

  it("stays open while focus moves from the trigger into rich content", async () => {
    const { tooltip, trigger, card } = createRichTooltip("Focusable card");
    card.tabIndex = 0;
    const outside = document.createElement("button");
    document.body.append(tooltip, outside);
    await commitTooltip(tooltip);

    focusTrigger(trigger);
    trigger.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: card }),
    );
    focusTrigger(card);
    await expectOpenCount(1);

    card.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: outside }),
    );
    await expectOpenCount(0);
  });

  it.each([false, true])(
    "returns Escape focus from rich content to its trigger (wrapped=%s)",
    async (wrapped) => {
      const { tooltip, trigger, card } = createRichTooltip("Focusable card");
      if (wrapped) {
        const wrapper = document.createElement("span");
        trigger.replaceWith(wrapper);
        wrapper.append(trigger);
      }
      const action = document.createElement("button");
      action.textContent = "Card action";
      card.append(action);
      document.body.append(tooltip);
      await commitTooltip(tooltip);
      trigger.focus();
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

  it("closes after pointer leave when nothing retains the rich tooltip", async () => {
    const { tooltip, trigger } = createRichTooltip("Hover-only card");
    document.body.append(tooltip);
    await commitTooltip(tooltip);

    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);

    dispatchMousePointer(trigger, "pointerleave");
    vi.advanceTimersByTime(99);
    await expectOpenCount(1);
    vi.advanceTimersByTime(1);
    await expectOpenCount(0);
  });

  it("closes on focusout to an outside element when not hovered", async () => {
    const { tooltip, trigger } = createRichTooltip("Focus-only card");
    const outside = document.createElement("button");
    document.body.append(tooltip, outside);
    await commitTooltip(tooltip);

    trigger.focus();
    await expectOpenCount(1);
    outside.focus();

    expect(document.activeElement).toBe(outside);
    await expectOpenCount(0);
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
      name: "contextual",
      title: "GPT-5.6 Sol · Chat only",
      text: "GPT-5.6 Sol",
      prepare: (_trigger: HTMLElement) => undefined,
    },
    {
      name: "icon-only",
      title: "Open settings",
      text: "",
      prepare: (_trigger: HTMLElement) => undefined,
    },
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
    expect(tooltipIsOpen(delegated!)).toBe(false);
    await settleTooltip(explicit.tooltip);
    expect(tooltipIsOpen(explicit.tooltip)).toBe(true);
  });

  it.each(["pointer", "focus"] as const)(
    "yields a %s title tooltip to a rich card without restoring the native title",
    async (input) => {
      const trigger = document.createElement("a");
      trigger.href = "https://example.com/item";
      trigger.title = trigger.href;
      trigger.textContent = "Item";
      document.body.append(trigger);
      const activate = () =>
        input === "pointer" ? dispatchMousePointer(trigger, "pointerover") : focusTrigger(trigger);
      activate();
      const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
      await commitTooltip(tooltip);
      vi.advanceTimersByTime(150);
      await expectOpenCount(1);

      const hovercard = new PortaledHovercardController(() => hovercard.reset());
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
      await commitTooltip(tooltip);
      vi.advanceTimersByTime(150);
      await expectOpenCount(1);
    },
  );

  it.each(["link", "subtree"])(
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
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(1);
      provider.append(moved === "link" ? link : wrapper);
      await vi.advanceTimersByTimeAsync(0);
      await expectOpenCount(0);
      expect(link.title).toBe("");
      expect(link.hasAttribute("aria-expanded")).toBe(false);
      document.body.append(moved === "link" ? link : wrapper);
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(0);
      dispatchMousePointer(link, "pointerleave");
      expect(link.title).toBe("Pull request details");
      dispatchMousePointer(link, "pointerover");
      await vi.advanceTimersByTimeAsync(200);
      await expectOpenCount(1);
      expect(link.href).toBe("https://github.com/openclaw/openclaw/pull/99816");
    },
  );

  it("keeps an inherited ordinary hint open while moving between ordinary links", async () => {
    const parent = document.createElement("div");
    parent.title = "Ordinary shared hint";
    const first = document.createElement("a");
    first.href = "https://example.com/first";
    first.textContent = "First";
    const second = document.createElement("a");
    second.href = "https://example.com/second";
    second.textContent = "Second";
    parent.append(first, second);
    document.body.append(parent);
    dispatchMousePointer(first, "pointerover");
    await vi.advanceTimersByTimeAsync(200);
    await expectOpenCount(1);
    const mounts: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        mounts.push(
          ...[...record.addedNodes].filter(
            (node) => node instanceof Element && node.matches("openclaw-tooltip"),
          ),
        );
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      dispatchMousePointer(second, "pointerover");
      await vi.advanceTimersByTimeAsync(0);
      expect(mounts).toEqual([]);
      await expectOpenCount(1);
    } finally {
      observer.disconnect();
    }
  });

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

  it("tracks dynamic titles and restores the latest title and accessible name", async () => {
    const trigger = document.createElement("button");
    trigger.title = "Pin widget";
    document.body.append(trigger);
    dispatchMousePointer(trigger, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    expect(tooltip).not.toBeNull();
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    expect(trigger.getAttribute("aria-label")).toBe("Pin widget");

    trigger.title = "Pinned widget";
    await Promise.resolve();
    await commitTooltip(tooltip);
    expect(tooltip.content).toBe("Pinned widget");
    expect(trigger.title).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Pinned widget");

    dispatchMousePointer(trigger, "pointerleave");
    expect(trigger.title).toBe("Pinned widget");
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    await expectOpenCount(0);
  });

  it.each(["", null])("dismisses an active title when it changes to %j", async (title) => {
    const trigger = document.createElement("button");
    trigger.title = "Action unavailable";
    document.body.append(trigger);
    dispatchMousePointer(trigger, "pointerover");
    const tooltip = document.querySelector<TooltipElement>("openclaw-tooltip")!;
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);

    if (title === null) {
      trigger.removeAttribute("title");
    } else {
      trigger.title = title;
    }
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.getAttribute("title")).toBe(title);
    trigger.title = "Action available";
    await Promise.resolve();
    await commitTooltip(tooltip);
    await expectOpenCount(0);
    dispatchMousePointer(trigger, "pointerleave");
    expect(trigger.getAttribute("title")).toBe("Action available");
    dispatchMousePointer(trigger, "pointerover");
    await commitTooltip(tooltip);
    vi.advanceTimersByTime(150);
    await expectOpenCount(1);
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
    expect(tooltipAnchor(tooltip)).toBe(rect);
    expect(rect.getAttribute("aria-label")).toBe("12 requests");
  });

  it("restores a removed suppressed trigger when hover moves elsewhere", () => {
    const removedTrigger = document.createElement("button");
    removedTrigger.title = "High";
    removedTrigger.textContent = "High";
    document.body.append(removedTrigger);
    removedTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(removedTrigger.getAttribute("title")).toBe("");
    removedTrigger.remove();

    const nextTrigger = document.createElement("button");
    nextTrigger.title = "Open settings";
    document.body.append(nextTrigger);
    nextTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));

    expect(removedTrigger.title).toBe("High");
    document.body.append(removedTrigger);
    removedTrigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(removedTrigger.getAttribute("title")).toBe("");
    removedTrigger.dispatchEvent(new MouseEvent("pointerleave", { composed: true }));
    expect(removedTrigger.title).toBe("High");
  });

  it("restores a suppressed title when the app-owned guard is disposed", () => {
    const trigger = document.createElement("button");
    trigger.title = "High";
    trigger.textContent = "High";
    document.body.append(trigger);
    trigger.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    expect(trigger.getAttribute("title")).toBe("");

    stopGuard?.();
    stopGuard = undefined;

    expect(trigger.title).toBe("High");
  });
});
