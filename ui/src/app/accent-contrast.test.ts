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
        const foreground = style.getPropertyValue("--" + family + state + "-foreground");
        expect(background).toMatch(/^#[a-f\d]{6}$/i);
        expect(foreground).toMatch(/^#[a-f\d]{6}$/i);
        expect(contrast(background, foreground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
);

it.each(["#ffffff", "#101014"])("keeps the focus ring visible on %s", (surface) => {
  const style = document.documentElement.style;
  style.setProperty("--bg", surface);
  applyControlUiAccent(surface);
  expect(contrast(style.getPropertyValue("--ring"), surface)).toBeGreaterThanOrEqual(3);
});
