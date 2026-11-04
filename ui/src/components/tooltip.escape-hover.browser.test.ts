import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { element, settleTooltip, tooltipSurface } from "./tooltip.test-support.ts";
import "../styles/base.css";

it("keeps an escaped preview closed when hiding exposes its hovered trigger", async () => {
  const trigger = element("button", { textContent: "Details" });
  trigger.style.cssText = "position:fixed;left:200px;top:200px";
  const rich = element("div", { textContent: "Preview details", tabIndex: 0 });
  rich.slot = "content";
  rich.style.cssText = "width:160px;height:100px";
  const tooltip = element("openclaw-tooltip", { delay: 0, openOnClick: true }, trigger, rich);
  const outside = element("button", { textContent: "Outside" });
  outside.style.cssText = "position:fixed;left:0;top:0";
  document.body.append(tooltip, outside);
  const events: string[] = [];
  try {
    await settleTooltip(tooltip);
    for (const type of ["overlay-show", "overlay-hide", "overlay-after-hide"]) {
      tooltip.addEventListener(type, () => events.push(type));
    }
    await page.elementLocator(trigger).hover();
    await expect.poll(() => tooltip.hasAttribute("open")).toBe(true);
    const surface = tooltipSurface(tooltip)!;
    const target = trigger.getBoundingClientRect();
    const popup = surface.getBoundingClientRect();
    surface.style.translate = `${target.x + target.width / 2 - popup.x - popup.width / 2}px ${target.y + target.height / 2 - popup.y - popup.height / 2}px`;
    await expect.poll(() => trigger.matches(":hover")).toBe(false);
    await expect.poll(() => rich.matches(":hover")).toBe(true);
    trigger.focus();
    events.length = 0;
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => events.includes("overlay-after-hide")).toBe(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(surface.matches(":popover-open")).toBe(false);
    expect(events).not.toContain("overlay-show");
    await page.elementLocator(outside).hover();
    await page.elementLocator(trigger).hover();
    await expect.poll(() => tooltip.hasAttribute("open")).toBe(true);
  } finally {
    tooltip.remove();
    outside.remove();
  }
});
