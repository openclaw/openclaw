import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { PluginRecommendedPrompts } from "./recommended-prompts.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;
let initialTheme: string | undefined;
let initialMode: string | undefined;
const frame = () => new Promise<number>(requestAnimationFrame);
const panel = () => container.querySelector<HTMLElement>(".plugin-recommended-prompts")!;
const layers = () => [
  ...container.querySelectorAll<HTMLElement>(".plugin-recommended-prompts__art > span"),
];
const rgb = (color: string, background = "transparent") => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
};

beforeEach(async () => {
  initialTheme = document.documentElement.dataset.theme;
  initialMode = document.documentElement.dataset.themeMode;
  await page.viewport(1440, 900);
  styles = document.createElement("style");
  styles.textContent = [baseStyles, componentStyles, pluginStyles].join("\n");
  styles.textContent += "* { transition: none !important; }";
  document.head.append(styles);
  container = document.createElement("div");
  container.style.cssText = "width:min(900px,100%);--accent:rgb(255 0 0);--primary:rgb(245 101 74)";
  document.body.append(container);
  mountSolid(
    () => (
      <PluginRecommendedPrompts
        id="fixture"
        name="Knowledge"
        prompts={[
          "Help me get started.",
          "Summarize a project note.",
          "Find our recent decisions.",
        ]}
        onSelect={vi.fn()}
      />
    ),
    { container },
  );
  await frame();
});
afterEach(() => {
  if (initialTheme === undefined) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = initialTheme;
  }
  if (initialMode === undefined) {
    delete document.documentElement.dataset.themeMode;
  } else {
    document.documentElement.dataset.themeMode = initialMode;
  }
  cleanupSolid();
  container.remove();
  styles.remove();
});
it("recolors the real artwork layers from live primary, independently of accent", async () => {
  const art = container.querySelector<HTMLElement>(".plugin-recommended-prompts__art")!;
  expect(getComputedStyle(art).isolation).toBe("isolate");
  expect(getComputedStyle(art).backgroundImage).toBe("none");
  const masks = layers().map((layer) => getComputedStyle(layer).maskImage);
  expect(masks).toHaveLength(3);
  for (const source of masks) {
    const url = /^url\(["']?(.*?)["']?\)$/u.exec(source)?.[1];
    expect(url).toBeTruthy();
    const image = new Image();
    image.src = url!;
    await image.decode();
    expect([image.naturalWidth, image.naturalHeight]).toEqual([1600, 560]);
  }
  for (const [mode, primary] of [
    ["light", [245, 101, 74]],
    ["dark", [32, 128, 244]],
    ["custom", [35, 190, 90]],
  ] as const) {
    document.documentElement.dataset.theme = mode === "custom" ? "light" : mode;
    document.documentElement.dataset.themeMode = mode === "dark" ? "dark" : "light";
    container.style.backgroundColor = "var(--bg)";
    if (mode === "custom") {
      container.style.cssText += ";--bg:#eef4ff;--card:#ffffff;--card-foreground:#182033";
    }
    container.style.setProperty("--primary", `rgb(${primary.join(" ")})`);
    await frame();
    expect(layers().map((layer) => rgb(getComputedStyle(layer).backgroundColor))).toEqual([
      [primary[0], 0, 0],
      [0, primary[1], 0],
      [0, 0, primary[2]],
    ]);
    expect(layers().map((layer) => getComputedStyle(layer).maskImage)).toEqual(masks);
    expect(layers().every((layer) => getComputedStyle(layer).mixBlendMode === "screen")).toBe(true);
    expect(getComputedStyle(panel()).backgroundColor).toBe(
      getComputedStyle(container).backgroundColor,
    );
    const row = container.querySelector<HTMLElement>(".plugin-recommended-prompts__prompt")!;
    const luminance = (color: string) =>
      rgb(color, getComputedStyle(panel()).backgroundColor)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((total, c, i) => total + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    const values = [getComputedStyle(row).color, getComputedStyle(row).backgroundColor]
      .map(luminance)
      .toSorted((a, b) => b - a);
    expect((values[0]! + 0.05) / (values[1]! + 0.05), mode).toBeGreaterThanOrEqual(4.5);
  }
});
