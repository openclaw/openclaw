import { expect, it } from "vitest";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import baseCss from "./base.css?inline";
import layoutCss from "./layout.css?inline";
import railCss from "./sidebar-rail.css?inline";

function luminance({ red, green, blue }: RenderedColor): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

it("keeps white Inbox counts readable on theme accents and custom colors", () => {
  const style = document.createElement("style");
  style.textContent = baseCss + layoutCss + railCss;
  const rail = document.createElement("div");
  rail.className = "sidebar-rail";
  const badge = document.createElement("span");
  badge.className = "sidebar-issues-button__count";
  badge.textContent = "9+";
  rail.append(badge);
  document.head.append(style);
  document.body.append(rail);
  try {
    for (const accent of [
      "#d97757",
      "#a8452a",
      "#ff5c5c",
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffff00",
      "#00ffff",
      "#ff00ff",
      "rgba(255, 255, 255, 0.1)",
      "transparent",
      "color(display-p3 0 1 0)",
      "oklch(0.8 0.4 150)",
      "oklch(0.8 0.4 190)",
    ]) {
      rail.style.setProperty("--accent", accent);
      const computed = getComputedStyle(badge);
      const colors = resolveRenderedColors({
        foreground: computed.color,
        background: computed.backgroundColor,
      });
      expect(colors.foreground, accent).toEqual({ red: 255, green: 255, blue: 255, alpha: 1 });
      expect(colors.background!.alpha, accent).toBe(1);
      expect(1.05 / (luminance(colors.background!) + 0.05), accent).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    rail.remove();
    style.remove();
  }
});
