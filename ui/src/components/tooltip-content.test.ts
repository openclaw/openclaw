import { describe, expect, it, vi } from "vitest";
import { collectTooltipNameText, isTooltipTextRedundant } from "./tooltip-content.ts";

describe("tooltip text redundancy", () => {
  it("skips style reads for an icon-only trigger", () => {
    const trigger = document.createElement("button");
    trigger.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"), " \n\t ");
    const style = vi.spyOn(window, "getComputedStyle");
    try {
      expect(isTooltipTextRedundant("Stop voice input", trigger)).toBe(false);
      expect(style).not.toHaveBeenCalled();
    } finally {
      style.mockRestore();
    }
  });

  it.each(["hidden", "display", "opacity", "content-visibility"])(
    "retains a tooltip for overflow below a %s text subtree",
    (hiddenBy) => {
      const trigger = document.createElement("button");
      trigger.append("Open settings");
      const wrapper = document.createElement("span");
      if (hiddenBy === "hidden") {
        wrapper.hidden = true;
      } else if (hiddenBy === "display") {
        wrapper.style.display = "none";
      } else if (hiddenBy === "opacity") {
        wrapper.style.opacity = "0";
      } else {
        wrapper.style.contentVisibility = "hidden";
      }
      const overflow = document.createElement("span");
      overflow.textContent = "Hidden detail";
      Object.defineProperties(overflow, {
        scrollWidth: { value: 20 },
        clientWidth: { value: 10 },
      });
      wrapper.append(overflow);
      trigger.append(wrapper);

      expect(isTooltipTextRedundant("Open settings", trigger)).toBe(false);
      overflow.remove();
      expect(isTooltipTextRedundant("Open settings", trigger)).toBe(true);
    },
  );

  it("collects visible descendants beneath visibility-hidden text", () => {
    const trigger = document.createElement("button");
    const hidden = document.createElement("span");
    hidden.style.visibility = "hidden";
    hidden.append("Hidden text");
    const visible = document.createElement("span");
    visible.style.visibility = "visible";
    visible.textContent = "Open settings";
    hidden.append(visible);
    trigger.append(hidden);

    expect(isTooltipTextRedundant("Open settings", trigger)).toBe(true);
    expect(isTooltipTextRedundant("Hidden text", trigger)).toBe(false);
  });

  it("measures overflow only after a text match and never for accessible naming", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open settings";
    const measure = vi.fn(() => 0);
    Object.defineProperty(trigger, "scrollWidth", { get: measure });

    expect(isTooltipTextRedundant("Other action", trigger)).toBe(false);
    expect(collectTooltipNameText(trigger)).toBe("Open settings");
    expect(measure).not.toHaveBeenCalled();
    expect(isTooltipTextRedundant("Open settings", trigger)).toBe(true);
    expect(measure).toHaveBeenCalledOnce();
  });
});
