import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { PluginRecommendedPrompts } from "./recommended-prompts.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
const panel = () => container.querySelector<HTMLElement>(".plugin-recommended-prompts")!;
const layers = () => [
  ...container.querySelectorAll<HTMLElement>(".plugin-recommended-prompts__art > span"),
];
const rgb = (color: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
};

beforeEach(async () => {
  await page.viewport(1440, 900);
  styles = document.createElement("style");
  styles.textContent = [baseStyles, componentStyles, pluginStyles].join("\n");
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
  cleanupSolid();
  container.remove();
  styles.remove();
});

it("recolors the real artwork layers from live primary, independently of accent", async () => {
  const art = container.querySelector<HTMLElement>(".plugin-recommended-prompts__art")!;
  expect(getComputedStyle(art).isolation).toBe("isolate");
  const substrate = getComputedStyle(art).backgroundImage;
  const masks = layers().map((layer) => getComputedStyle(layer).maskImage);
  expect(masks).toHaveLength(3);
  await Promise.all(
    [substrate, ...masks].map(async (source) => {
      const url = /^url\(["']?(.*?)["']?\)$/u.exec(source)?.[1];
      expect(url).toBeTruthy();
      const image = new Image();
      image.src = url!;
      await image.decode();
      expect([image.naturalWidth, image.naturalHeight]).toEqual([1600, 560]);
    }),
  );
  for (const primary of [
    [245, 101, 74],
    [32, 128, 244],
    [35, 190, 90],
  ]) {
    container.style.setProperty("--primary", `rgb(${primary.join(" ")})`);
    await frame();
    expect(layers().map((layer) => rgb(getComputedStyle(layer).backgroundColor))).toEqual([
      [primary[0], 0, 0],
      [0, primary[1], 0],
      [0, 0, primary[2]],
    ]);
    expect(layers().map((layer) => getComputedStyle(layer).maskImage)).toEqual(masks);
    expect(layers().every((layer) => getComputedStyle(layer).mixBlendMode === "screen")).toBe(true);
    expect(getComputedStyle(art).backgroundImage).toBe(substrate);
    expect(
      rgb(getComputedStyle(container.querySelector(".plugin-recommended-prompts__text")!).color),
    ).toEqual([255, 255, 255]);
  }
});

it.each([390, 768, 1366, 1440])(
  "centers every prompt and keeps text left-aligned at %i px",
  async (width) => {
    await page.viewport(width, 900);
    await frame();
    const bounds = panel().getBoundingClientRect();
    for (const row of container.querySelectorAll<HTMLElement>(
      ".plugin-recommended-prompts__prompt",
    )) {
      const rect = row.getBoundingClientRect();
      expect(Math.abs(rect.x + rect.width / 2 - (bounds.x + bounds.width / 2))).toBeLessThanOrEqual(
        1,
      );
      expect(["start", "left"]).toContain(getComputedStyle(row).textAlign);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
    expect(panel().scrollWidth).toBeLessThanOrEqual(panel().clientWidth);
  },
);
