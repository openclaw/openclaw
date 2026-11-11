import type { Locator } from "playwright";
import { expect } from "vitest";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";

function luminance(color: RenderedColor | undefined): number {
  if (!color || color.alpha !== 1) {
    throw new Error("Toast contrast needs an opaque rendered color");
  }
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}

export async function expectAttachmentErrorToast(toast: Locator, minimumContrast = 4.5) {
  const raw = await toast.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    element.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.style.color = "var(--popover)";
    const neutral = getComputedStyle(probe).color;
    probe.remove();
    const icon = element.querySelector(".app-toast__icon");
    if (!icon || !element.querySelector(".app-toast__dismiss")) {
      throw new Error("Error toast has no severity icon or dismiss control");
    }
    return {
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
      icon: getComputedStyle(icon).color,
      danger,
      neutral,
    };
  });
  const colors = await toast.page().evaluate(resolveRenderedColors, raw);
  // The icon carries the only error signal; the card keeps the neutral surface.
  expect(colors.icon).toEqual(colors.danger);
  expect(colors.foreground).not.toEqual(colors.danger);
  expect(colors.background).toEqual(colors.neutral);
  expect(await toast.getAttribute("role")).toBe("alert");
  const [a, b] = [luminance(colors.foreground), luminance(colors.background)];
  expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(minimumContrast);
}
