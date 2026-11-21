import { describe, expect, it, onTestFinished } from "vitest";
import { createPortaledHovercard, createPortaledHovercardOwner } from "./portaled-hovercard.ts";

// Root test shards also collect browser files under jsdom, which has no layout or hit-testing.
const hasPopoverApi = typeof HTMLElement.prototype.showPopover === "function";

function placementCase(
  name: string,
  viewport: [number, number],
  anchor: [number, number],
  placement: "horizontal" | "vertical",
  side: string,
  x: number,
  y: number,
  cardHeight = 136,
  overlaps = false,
) {
  return { name, viewport, anchor, placement, cardHeight, expected: { side, x, y, overlaps } };
}

const cases = [
  placementCase("narrow horizontal below", [390, 844], [14, 384], "horizontal", "bottom", 14, 424),
  placementCase("narrow horizontal above", [390, 844], [14, 744], "horizontal", "top", 14, 598),
  placementCase("desktop right", [1440, 900], [14, 384], "horizontal", "right", 306, 384),
  placementCase("desktop left", [1440, 900], [1120, 384], "horizontal", "left", 816, 384),
  placementCase("vertical below", [390, 844], [14, 384], "vertical", "bottom", 14, 424),
  placementCase("vertical above", [390, 844], [14, 744], "vertical", "top", 14, 598),
  placementCase(
    "neither axis fits",
    [390, 844],
    [14, 384],
    "horizontal",
    "left",
    12,
    312,
    520,
    true,
  ),
];

describe.skipIf(!hasPopoverApi)("portaled hovercard placement", () => {
  it.each(cases)("$name", async ({ viewport, anchor, placement, cardHeight, expected }) => {
    const { page } = await import("vitest/browser");
    const originalViewport = [innerWidth, innerHeight] as const;
    onTestFinished(() => page.viewport(...originalViewport));
    await page.viewport(...viewport);

    const trigger = document.createElement("a");
    trigger.href = "#conversation";
    trigger.textContent = "Open conversation";
    trigger.style.cssText = `position: fixed; left: ${anchor[0]}px; top: ${anchor[1]}px;
      width: 282px; height: 30px; box-sizing: border-box; padding: 0; margin: 0; border: 0;`;
    document.body.append(trigger);
    const card = createPortaledHovercard("placement-preview", "placement-preview");
    card.style.cssText = `position: fixed; inset: auto; width: 294px; height: ${cardHeight}px;
      box-sizing: border-box; padding: 0; margin: 0; border: 0;`;
    const controller = createPortaledHovercardOwner(() => controller.reset());
    onTestFinished(() => {
      controller.reset();
      trigger.remove();
    });
    controller.markTrigger(trigger);
    controller.mount(trigger, card, placement);

    const row = trigger.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const hit = document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2);
    // Oversized cards retain the existing clamp; this repair promises clearance only when it fits.
    expect(hit).toBe(expected.overlaps ? card : trigger);
    expect(
      box.left < row.right && box.right > row.left && box.top < row.bottom && box.bottom > row.top,
    ).toBe(expected.overlaps);
    expect(card.dataset.side).toBe(expected.side);
    expect(box).toMatchObject({
      x: expected.x,
      y: expected.y,
      width: 294,
      height: cardHeight,
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport[0]);
    expect(box.bottom).toBeLessThanOrEqual(viewport[1]);
  });
});
