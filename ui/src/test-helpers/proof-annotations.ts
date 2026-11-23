import { readFile } from "node:fs/promises";
import type { Browser } from "playwright";
import {
  renderProofAnnotations,
  validateProofAnnotations,
  type ProofAnnotation,
  type ProofViewport,
} from "../../../scripts/lib/proof-annotations.ts";

/** With an image, produces an annotated still; otherwise a transparent video overlay. */
export async function rasterizeProofAnnotations(
  browser: Browser,
  options: {
    viewport: ProofViewport;
    scale: number;
    annotations: ProofAnnotation[];
    image?: Buffer;
  },
) {
  const { viewport, scale, annotations, image } = options;
  validateProofAnnotations(annotations, viewport);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("Annotation scale must be positive");
  }
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    const font = await readFile(new URL("../../public/fonts/dm-sans-latin.woff2", import.meta.url));
    await page.setContent(
      `<style>@font-face{font-family:"DM Sans";src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2");font-weight:100 1000}html,body{margin:0;background:transparent}img,svg{position:absolute;inset:0}img{width:100%;height:100%}</style>${image ? '<img alt="Raw evidence">' : ""}${renderProofAnnotations(annotations, viewport)}`,
    );
    if (image) {
      const size = await page.locator("img").evaluate(
        async (img, source) => {
          if (!(img instanceof HTMLImageElement)) {
            throw new Error("Expected the raw screenshot image");
          }
          img.src = source;
          await img.decode();
          return { width: img.naturalWidth, height: img.naturalHeight };
        },
        `data:image/png;base64,${image.toString("base64")}`,
      );
      if (size.width !== viewport.width * scale || size.height !== viewport.height * scale) {
        throw new Error(
          "Screenshot dimensions must equal viewport × scale; preserve the original capture geometry",
        );
      }
    }
    await page.evaluate(() => document.fonts.ready);
    const fits = await page.locator(".proof-label").evaluateAll((groups) =>
      groups.every((group) => {
        const card = group.querySelector(".proof-card")!.getBoundingClientRect();
        return (
          card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight
        );
      }),
    );
    if (!fits) {
      throw new Error("Annotation label overflow; shorten the label");
    }
    return await page.screenshot({ omitBackground: true });
  } finally {
    await context.close();
  }
}
