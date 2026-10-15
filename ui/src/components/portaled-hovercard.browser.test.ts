import { describe, expect, it, onTestFinished } from "vitest";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

// Root test shards also collect browser files under jsdom, which has no layout or hit-testing.
const hasPopoverApi = typeof HTMLElement.prototype.showPopover === "function";

type PlacementCase = {
  name: string;
  viewport: [number, number];
  anchor: [number, number];
  placement: "horizontal" | "vertical";
  cardHeight: number;
  expected: { side: string; x: number; y: number; overlaps: boolean };
};

const cases: PlacementCase[] = [
  {
    name: "narrow horizontal card below the row",
    viewport: [390, 844],
    anchor: [14, 384],
    placement: "horizontal",
    cardHeight: 136,
    expected: { side: "bottom", x: 14, y: 424, overlaps: false },
  },
  {
    name: "narrow horizontal card above the bottom row",
    viewport: [390, 844],
    anchor: [14, 744],
    placement: "horizontal",
    cardHeight: 136,
    expected: { side: "top", x: 14, y: 598, overlaps: false },
  },
  {
    name: "desktop horizontal card on the right",
    viewport: [1440, 900],
    anchor: [14, 384],
    placement: "horizontal",
    cardHeight: 136,
    expected: { side: "right", x: 306, y: 384, overlaps: false },
  },
  {
    name: "desktop horizontal card on the left",
    viewport: [1440, 900],
    anchor: [1120, 384],
    placement: "horizontal",
    cardHeight: 136,
    expected: { side: "left", x: 816, y: 384, overlaps: false },
  },
  {
    name: "existing vertical card below the row",
    viewport: [390, 844],
    anchor: [14, 384],
    placement: "vertical",
    cardHeight: 136,
    expected: { side: "bottom", x: 14, y: 424, overlaps: false },
  },
  {
    name: "existing vertical card above the bottom row",
    viewport: [390, 844],
    anchor: [14, 744],
    placement: "vertical",
    cardHeight: 136,
    expected: { side: "top", x: 14, y: 598, overlaps: false },
  },
  {
    name: "existing horizontal clamp when neither axis has room",
    viewport: [390, 844],
    anchor: [14, 384],
    placement: "horizontal",
    cardHeight: 520,
    expected: { side: "left", x: 12, y: 312, overlaps: true },
  },
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
    const controller = new PortaledHovercardController(() => controller.reset());
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
    expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({
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
