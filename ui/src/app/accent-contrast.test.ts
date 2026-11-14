/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { applyControlUiAccent } from "./control-ui-presentation.ts";

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

afterEach(() => {
  applyControlUiAccent("theme");
  document.documentElement.removeAttribute("style");
});

it.each(["#707070", "#ffff00", "#080808", "#fafafa"])(
  "publishes readable normal, hover and active accent pairs for %s",
  (accent) => {
    const style = document.documentElement.style;
    style.setProperty("--bg", "#ffffff");
    applyControlUiAccent(accent);
    for (const family of ["accent", "primary"]) {
      for (const state of ["", "-hover", "-active"]) {
        const background = style.getPropertyValue("--" + family + state);
        const foreground = style.getPropertyValue("--" + family + "-foreground");
        expect(background).toMatch(/^#[a-f\d]{6}$/i);
        expect(foreground).toMatch(/^#[a-f\d]{6}$/i);
        expect(contrast(background, foreground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
);

it.each(
  ["#707070", "#ffff00", "#080808", "#fafafa"].flatMap((accent) =>
    ["#ffffff", "#101014"].map((surface) => ({ accent, surface })),
  ),
)("keeps inset focus visible for $accent on $surface", ({ accent, surface }) => {
  const style = document.documentElement.style;
  style.setProperty("--bg", surface);
  applyControlUiAccent(accent);
  const ring = style.getPropertyValue("--ring");
  expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
  for (const family of ["accent", "primary"]) {
    for (const state of ["", "-hover", "-active"]) {
      expect(contrast(ring, style.getPropertyValue(`--${family}${state}`))).toBeGreaterThanOrEqual(
        3,
      );
    }
  }
});

it("keeps the ring visible on both the page and an elevated control surface", () => {
  const style = document.documentElement.style;
  style.setProperty("--bg", "#ffffff");
  style.setProperty("--card", "#707070");
  applyControlUiAccent("#707070");
  const ring = style.getPropertyValue("--ring");
  expect(contrast(ring, "#ffffff")).toBeGreaterThanOrEqual(3);
  expect(contrast(ring, "#707070")).toBeGreaterThanOrEqual(3);
});

it("preserves authored primary and send ink before and after a custom accent", () => {
  const palette = document.head.appendChild(document.createElement("style"));
  palette.textContent =
    ":root { --accent: #d97757; --accent-hover: #e68b6b; --accent-foreground: #fffefa; --primary: #d97757; --primary-hover: #e68b6b; --primary-foreground: #241f1b; --chat-send-foreground: #ffffff; --chat-send-hover-bg: #ba6650; --bg: #101014; }";
  const root = document.documentElement;
  try {
    for (const accent of ["theme", "#707070", "theme"]) {
      applyControlUiAccent(accent);
      if (accent !== "theme") {
        expect(root.style.getPropertyValue("--chat-send-foreground")).toBe("#ffffff");
        continue;
      }
      const computed = getComputedStyle(root);
      for (const [family, ink] of [
        ["accent", "#fffefa"],
        ["primary", "#241f1b"],
        ["chat-send", "#ffffff"],
      ]) {
        expect(root.style.getPropertyValue("--" + family + "-foreground")).toBe("");
        expect(computed.getPropertyValue("--" + family + "-foreground").trim()).toBe(ink);
        for (const state of ["hover", "active"]) {
          const property = "--" + family + "-" + state + (family === "chat-send" ? "-bg" : "");
          expect(contrast(root.style.getPropertyValue(property), ink!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  } finally {
    palette.remove();
  }
});
