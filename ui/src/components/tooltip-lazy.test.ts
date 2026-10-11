/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as lazyCustomElement from "../app/lazy-custom-element.ts";
import * as toast from "../lib/toast.ts";
import {
  createTooltip,
  dispatchMousePointer,
  hoverTrigger,
  settleTooltip,
  webAwesomeTooltip,
} from "./tooltip.test-support.ts";

describe("lazy tooltip materialization", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("materializes on first hover intent and reuses the popup while preserving descriptions", async () => {
    const { tooltip, trigger } = createTooltip("Hover details");
    const untouched = createTooltip("Untouched details");
    document.body.append(tooltip, untouched.tooltip);
    await Promise.all([tooltip.updateComplete, untouched.tooltip.updateComplete]);

    const descriptionId = trigger.getAttribute("aria-describedby")!;
    expect(document.getElementById(descriptionId)?.textContent).toBe("Hover details");
    expect(webAwesomeTooltip(tooltip)).toBeNull();
    hoverTrigger(trigger);
    vi.advanceTimersByTime(149);
    expect(webAwesomeTooltip(tooltip)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tooltip.hasAttribute("open")).toBe(true);
    await settleTooltip(tooltip);

    const popup = webAwesomeTooltip(tooltip)!;
    expect(popup.open).toBe(true);
    expect(popup.anchor).toBe(trigger);
    expect(webAwesomeTooltip(untouched.tooltip)).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
    expect(document.getElementById(descriptionId)?.textContent).toBe("Hover details");

    dispatchMousePointer(trigger, "pointerleave");
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(popup.open).toBe(false);
    await settleTooltip(tooltip);
    expect(webAwesomeTooltip(tooltip)).toBe(popup);
    hoverTrigger(trigger);
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
    expect(webAwesomeTooltip(tooltip)).toBe(popup);
    expect(popup.open).toBe(true);
    expect(tooltip.hasAttribute("open")).toBe(true);
    expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
  });

  it("waits for the nested popup render before opening", async () => {
    await import("@awesome.me/webawesome/dist/components/tooltip/tooltip.js");
    const definition = createDeferred();
    vi.spyOn(lazyCustomElement, "ensureCustomElementDefined").mockReturnValueOnce(
      definition.promise,
    );
    const { tooltip, trigger } = createTooltip("Nested popup readiness");
    tooltip.openOnClick = true;
    document.body.append(tooltip);
    await tooltip.updateComplete;
    trigger.click();
    await tooltip.updateComplete;
    const rendered = webAwesomeTooltip(tooltip)!;
    await rendered.updateComplete;
    const ready = createDeferred();
    const popup = rendered.popup;
    const initialUpdate = popup.updateComplete;
    vi.spyOn(popup, "updateComplete", "get").mockReturnValue(
      Promise.all([initialUpdate, ready.promise]).then(() => true),
    );
    try {
      rendered.anchor = null;
      definition.resolve();
      await vi.waitFor(() => expect(rendered.anchor).toBe(trigger));
      expect(rendered.open).toBe(false);
      ready.resolve();
      await vi.waitFor(() => expect(rendered.open).toBe(true));
    } finally {
      ready.resolve();
    }
  });

  it.each(["pointer", "focus"] as const)(
    "materializes an anchor preview from %s intent",
    async (input) => {
      const tooltip = document.createElement("openclaw-tooltip");
      const anchor = document.createElement("button");
      anchor.textContent = "Preview";
      document.body.append(anchor, tooltip);
      await tooltip.updateComplete;
      expect(webAwesomeTooltip(tooltip)).toBeNull();

      tooltip.previewForAnchor(anchor, "Preview details", input);
      await tooltip.updateComplete;
      vi.advanceTimersByTime(150);
      await settleTooltip(tooltip);
      expect(webAwesomeTooltip(tooltip)?.open).toBe(true);
      expect(webAwesomeTooltip(tooltip)?.anchor).toBe(anchor);
      expect(tooltip.hasAttribute("open")).toBe(true);
      expect(document.getElementById(anchor.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Preview details",
      );
    },
  );

  it.each(["open", "escape", "disconnect", "toggle", "failure"] as const)(
    "preserves %s intent while the popup definition is loading",
    async (outcome) => {
      const loading = createDeferred();
      vi.spyOn(lazyCustomElement, "ensureCustomElementDefined").mockReturnValueOnce(
        loading.promise,
      );
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { tooltip, trigger } = createTooltip("Loading details");
      tooltip.openOnClick = true;
      document.body.append(tooltip);
      await tooltip.updateComplete;

      trigger.click();
      expect(tooltip.hasAttribute("open")).toBe(true);
      await tooltip.updateComplete;
      const popup = webAwesomeTooltip(tooltip)!;
      expect(popup.open).not.toBe(true);
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
      if (outcome === "failure") {
        loading.reject(new Error("Tooltip import failed"));
      } else {
        await import("@awesome.me/webawesome/dist/components/tooltip/tooltip.js");
        loading.resolve();
      }
      await settleTooltip(tooltip);

      expect(popup.open).toBe(outcome === "open");
      expect(tooltip.hasAttribute("open")).toBe(outcome === "open");
      if (outcome === "failure") {
        expect(showToast).toHaveBeenCalledExactlyOnceWith({ message: "Tooltip import failed" });
      } else {
        expect(showToast).not.toHaveBeenCalled();
      }
    },
  );
});
