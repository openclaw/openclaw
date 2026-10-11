/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTooltip,
  dispatchMousePointer,
  hoverTrigger,
  settleTooltip,
  tooltipSurface,
} from "./tooltip.test-support.ts";

describe("lazy tooltip content materialization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for the native surface to render before opening an anchor preview", async () => {
    const tooltip = document.createElement("openclaw-tooltip");
    const anchor = document.createElement("button");
    anchor.textContent = "Preview";
    document.body.append(anchor, tooltip);

    tooltip.previewForAnchor(anchor, "Preview details", "focus");
    expect(tooltip.hasAttribute("open")).toBe(false);
    await settleTooltip(tooltip);

    expect(tooltipSurface(tooltip)?.matches(":popover-open")).toBe(true);
    expect(tooltipSurface(tooltip)?.querySelector(".tooltip-content")?.textContent).toBe(
      "Preview details",
    );
  });

  it("materializes content on first hover intent and reuses the native surface", async () => {
    const { tooltip, trigger } = createTooltip("Hover details");
    const untouched = createTooltip("Untouched details");
    document.body.append(tooltip, untouched.tooltip);
    await Promise.all([settleTooltip(tooltip), settleTooltip(untouched.tooltip)]);
    const descriptionId = trigger.getAttribute("aria-describedby")!;
    expect(document.getElementById(descriptionId)?.textContent).toBe("Hover details");
    const popup = tooltipSurface(tooltip)!;
    expect(popup.querySelector(".tooltip-content")).toBeNull();
    hoverTrigger(trigger);
    vi.advanceTimersByTime(149);
    expect(popup.querySelector(".tooltip-content")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tooltip.hasAttribute("open")).toBe(true);
    await settleTooltip(tooltip);
    expect(popup.matches(":popover-open")).toBe(true);
    expect(popup.querySelector(".tooltip-content")?.textContent).toBe("Hover details");
    expect(tooltipSurface(untouched.tooltip)?.querySelector(".tooltip-content")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
    dispatchMousePointer(trigger, "pointerleave");
    expect(popup.matches(":popover-open")).toBe(false);
    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
    expect(tooltipSurface(tooltip)).toBe(popup);
    expect(popup.matches(":popover-open")).toBe(true);
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
  });

  it.each(["pointer", "focus"] as const)(
    "materializes an anchor preview from %s intent",
    async (input) => {
      const tooltip = document.createElement("openclaw-tooltip");
      const anchor = document.createElement("button");
      anchor.textContent = "Preview";
      document.body.append(anchor, tooltip);
      await settleTooltip(tooltip);
      expect(tooltipSurface(tooltip)?.querySelector(".tooltip-content")).toBeNull();
      tooltip.previewForAnchor(anchor, "Preview details", input);
      await settleTooltip(tooltip);
      vi.advanceTimersByTime(150);
      await settleTooltip(tooltip);
      expect(tooltipSurface(tooltip)?.matches(":popover-open")).toBe(true);
      expect(document.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Preview details",
      );
    },
  );

  it.each(["open", "escape", "disconnect", "toggle", "veto"] as const)(
    "preserves %s intent during first content materialization",
    async (outcome) => {
      const { tooltip, trigger } = createTooltip("Details");
      tooltip.openOnClick = true;
      document.body.append(tooltip);
      await settleTooltip(tooltip);
      if (outcome === "veto") {
        tooltip.addEventListener("wa-show", (event) => event.preventDefault(), { once: true });
      }
      trigger.click();
      if (outcome === "escape") {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        trigger.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(true);
      } else if (outcome === "disconnect") {
        tooltip.remove();
      } else if (outcome === "toggle") {
        trigger.click();
      }
      await settleTooltip(tooltip);
      expect(tooltip.hasAttribute("open")).toBe(outcome === "open");
      expect(tooltipSurface(tooltip)?.matches(":popover-open") ?? false).toBe(outcome === "open");
    },
  );
});
